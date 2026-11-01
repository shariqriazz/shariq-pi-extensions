import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/**
 * Replaces images with a vision model's description when they enter the
 * conversation, so the main model's history holds text only. The swap happens
 * once, before the message is stored, so earlier requests never change and the
 * prompt cache keeps working. Off unless enabled in image-descriptions.json.
 */

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ImageDescriptionsConfig {
  enabled: boolean;
  /** "provider/model-id" of an image-capable model. */
  model: string;
  thinkingLevel: ThinkingLevel;
}

export const DEFAULT_CONFIG: ImageDescriptionsConfig = { enabled: false, model: "", thinkingLevel: "low" };

export function configPath(): string {
  return path.join(getAgentDir(), "image-descriptions.json");
}

export function loadConfig(file = configPath()): ImageDescriptionsConfig {
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ImageDescriptionsConfig>;
    return {
      enabled: raw.enabled === true,
      model: typeof raw.model === "string" ? raw.model.trim() : "",
      thinkingLevel: THINKING_LEVELS.includes(raw.thinkingLevel as ThinkingLevel)
        ? (raw.thinkingLevel as ThinkingLevel)
        : DEFAULT_CONFIG.thinkingLevel,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

const SYSTEM_PROMPT = [
  "You describe an image for an AI coding agent that cannot see it. The agent will rely only on your text.",
  "Transcribe all legible text exactly, including error messages, code, labels, numbers, and URLs.",
  "Describe the layout, the main elements, their state, and anything that looks wrong or notable, focusing on what the stated purpose needs.",
  "Be complete but concise. Do not guess at text you cannot read; say it is unreadable.",
].join("\n");

const DESCRIBE_TIMEOUT_MS = 120_000;
const MAX_DESCRIPTION_TOKENS = 4_000;
const STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const VIEW_FALLBACK_RESIZE = { maxWidth: 1568, maxHeight: 1568, maxBytes: 1_000_000 };
const OWN_TOOLS = new Set(["ask_image", "view_image"]);

const EXTENSION_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
const MIME_FOR_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function storeDir(): string {
  return path.join(getAgentDir(), "image-descriptions");
}

/** Keep a copy so later questions see this image even if the source file changes. */
function storeImage(image: ImageContent): string {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const hash = createHash("sha256").update(image.data).digest("hex").slice(0, 32);
  const file = path.join(dir, `${hash}.${EXTENSION_FOR_MIME[image.mimeType] ?? "img"}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
  return file;
}

function pruneStore(): void {
  const dir = storeDir();
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - STORE_MAX_AGE_MS;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    } catch {
      // A file removed meanwhile needs no pruning.
    }
  }
}

function readImageFile(cwd: string, requested: string): ImageContent {
  const file = path.resolve(cwd, requested);
  const mimeType = MIME_FOR_EXTENSION[path.extname(file).slice(1).toLowerCase()];
  if (!mimeType) throw new Error(`Not a supported image file (png, jpg, webp, gif): ${file}`);
  return { type: "image", data: fs.readFileSync(file).toString("base64"), mimeType };
}

function resolveModel(ctx: ExtensionContext, config: ImageDescriptionsConfig) {
  const [provider, ...rest] = config.model.split("/");
  const model = rest.length ? ctx.modelRegistry.find(provider!, rest.join("/")) : undefined;
  if (!model) throw new Error(`Image description model "${config.model}" is not in the model registry.`);
  if (!model.input.includes("image")) throw new Error(`Model "${config.model}" does not accept images.`);
  return model;
}

/** Ask the configured vision model about one image. */
export async function askVisionModel(
  ctx: ExtensionContext,
  config: ImageDescriptionsConfig,
  image: ImageContent,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const model = resolveModel(ctx, config);
  const timeout = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
  const options: Record<string, unknown> = {
    maxTokens: Math.min(MAX_DESCRIPTION_TOKENS, model.maxTokens || MAX_DESCRIPTION_TOKENS),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    cacheRetention: "none",
  };
  if (model.reasoning && config.thinkingLevel !== "off") options.reasoning = config.thinkingLevel;
  const response = await ctx.modelRegistry
    .streamSimple(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }, image],
            timestamp: Date.now(),
          },
        ],
      },
      options as any,
    )
    .result();
  if (response.stopReason !== "stop" && response.stopReason !== "length") {
    throw new Error(response.errorMessage || `Vision model stopped with "${response.stopReason}".`);
  }
  const text = response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Vision model returned no description.");
  return text;
}

function descriptionBlock(config: ImageDescriptionsConfig, file: string, description: string): string {
  const label = config.model.split("/").pop() ?? config.model;
  return `[Image described by ${label}; saved at ${file}. Use ask_image for details or view_image to see it.]\n${description}`;
}

function excerpt(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export default function imageDescriptions(pi: ExtensionAPI) {
  const config = loadConfig();
  if (!config.enabled || !config.model) return;
  let lastUserText = "";

  /** Describe each image; an image whose description fails stays an image. */
  const describeAll = async (
    ctx: ExtensionContext,
    images: ImageContent[],
    purpose: string,
    signal?: AbortSignal,
  ): Promise<Array<{ image: ImageContent; text?: string }>> =>
    Promise.all(
      images.map(async (image) => {
        try {
          const file = storeImage(image);
          const description = await askVisionModel(ctx, config, image, purpose, signal);
          return { image, text: descriptionBlock(config, file, description) };
        } catch (error) {
          if (signal?.aborted) throw error;
          if (ctx.hasUI)
            ctx.ui.notify(`Image left as is: ${error instanceof Error ? error.message : String(error)}`, "warning");
          return { image };
        }
      }),
    );

  pi.on("session_start", () => {
    try {
      pruneStore();
    } catch {
      // Pruning is housekeeping; a failure must not block the session.
    }
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    lastUserText = event.text;
    if (!event.images?.length) return { action: "continue" };
    const purpose = `The user attached this image to their message:\n"""\n${excerpt(event.text, 4_000) || "(no text)"}\n"""`;
    const results = await describeAll(ctx, event.images, purpose, ctx.signal);
    if (results.every((result) => result.text === undefined)) return { action: "continue" };
    const texts = results.flatMap((result) => (result.text ? [result.text] : []));
    return {
      action: "transform",
      text: [event.text, ...texts].filter(Boolean).join("\n\n"),
      images: results.filter((result) => result.text === undefined).map((result) => result.image),
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    // Nested calls return to a script, not the conversation; the script's own result is handled.
    if (OWN_TOOLS.has(event.toolName) || event.parentToolCallId) return undefined;
    const images = event.content.filter((block): block is ImageContent => block.type === "image");
    if (images.length === 0) return undefined;
    const purpose = [
      `The agent received this image from the ${event.toolName} tool with input ${excerpt(JSON.stringify(event.input), 1_000)}.`,
      lastUserText ? `The user's latest request:\n"""\n${excerpt(lastUserText, 4_000)}\n"""` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const results = await describeAll(ctx, images, purpose, ctx.signal);
    if (results.every((result) => result.text === undefined)) return undefined;
    const described = new Map(results.map((result) => [result.image, result.text]));
    return {
      content: event.content.map((block): TextContent | ImageContent => {
        const text = block.type === "image" ? described.get(block) : undefined;
        return text ? { type: "text", text } : block;
      }),
    };
  });

  pi.registerTool({
    name: "ask_image",
    label: "Ask About Image",
    description: "Ask the vision model a question about an image file, such as one saved from a described image.",
    exposure: "model-only",
    annotations: { readOnlyHint: true, openWorldHint: true },
    parameters: Type.Object({
      path: Type.String({ description: "Image file path." }),
      question: Type.String({ description: "What to find out about the image." }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const image = readImageFile(ctx.cwd, params.path);
      const answer = await askVisionModel(ctx, config, image, params.question, signal);
      return { content: [{ type: "text", text: answer }], details: { path: params.path } };
    },
  });

  pi.registerTool({
    name: "view_image",
    label: "View Image",
    description:
      "Show an image file to you directly instead of as a description. Use it only when a description cannot answer the question.",
    exposure: "model-only",
    annotations: { readOnlyHint: true, openWorldHint: false },
    parameters: Type.Object({
      path: Type.String({ description: "Image file path." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const image = readImageFile(ctx.cwd, params.path);
      const resized = await resizeImage(
        Buffer.from(image.data, "base64"),
        image.mimeType,
        ctx.model?.inputLimits?.images?.resize ?? VIEW_FALLBACK_RESIZE,
      );
      const shown: ImageContent = resized ? { type: "image", data: resized.data, mimeType: resized.mimeType } : image;
      return {
        content: [{ type: "text", text: `Image ${params.path}:` }, shown],
        details: { path: params.path, width: resized?.width, height: resized?.height },
      };
    },
  });
}
