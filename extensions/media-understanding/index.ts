import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatDimensionNote, getAgentDir, resizeImage } from "@earendil-works/pi-coding-agent";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/**
 * Optional helper models for media. Each part is enabled on its own in
 * media-understanding.json: image tools (view_image, ask_image, with zoom),
 * describing images as they arrive, and ask_video / ask_audio. Images that are
 * described are swapped once, before the message is stored, so earlier requests
 * never change and the prompt cache keeps working.
 */

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];
const DESCRIBE_MODES = ["off", "auto", "always"] as const;
type DescribeMode = (typeof DESCRIBE_MODES)[number];

export interface ModelChoice {
  /** "provider/model-id". */
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface MediaUnderstandingConfig {
  images: ModelChoice & {
    /** Registers view_image and, with a model, ask_image. */
    enabled: boolean;
    /** "auto" describes images only for models that cannot take images; "always" for every model. */
    describeOnArrival: DescribeMode;
  };
  video: ModelChoice & { enabled: boolean };
  audio: ModelChoice & { enabled: boolean };
  /** Largest video or audio file to send, in megabytes. */
  maxFileMB: number;
  /** How often view_image may show the same image and region per session; 0 is unlimited. */
  maxViewsPerImage: number;
}

const offChoice = { enabled: false, model: "", thinkingLevel: "low" as ThinkingLevel };
export const DEFAULT_CONFIG: MediaUnderstandingConfig = {
  images: { ...offChoice, describeOnArrival: "off" },
  video: { ...offChoice },
  audio: { ...offChoice },
  maxFileMB: 20,
  maxViewsPerImage: 3,
};

export function configPath(): string {
  return path.join(getAgentDir(), "media-understanding.json");
}

function parseChoice(raw: any): ModelChoice & { enabled: boolean } {
  return {
    enabled: raw?.enabled === true,
    model: typeof raw?.model === "string" ? raw.model.trim() : "",
    thinkingLevel: THINKING_LEVELS.includes(raw?.thinkingLevel) ? raw.thinkingLevel : "low",
  };
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export function loadConfig(file = configPath()): MediaUnderstandingConfig {
  try {
    if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as any;
    return {
      images: {
        ...parseChoice(raw.images),
        describeOnArrival: DESCRIBE_MODES.includes(raw.images?.describeOnArrival)
          ? raw.images.describeOnArrival
          : "off",
      },
      video: parseChoice(raw.video),
      audio: parseChoice(raw.audio),
      maxFileMB: boundedNumber(raw.maxFileMB, 1, 500, DEFAULT_CONFIG.maxFileMB),
      maxViewsPerImage: Math.round(boundedNumber(raw.maxViewsPerImage, 0, 1000, DEFAULT_CONFIG.maxViewsPerImage)),
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

const IMAGE_PROMPT = [
  "You describe an image for an AI coding agent that cannot see it. The agent will rely only on your text.",
  "Transcribe all legible text exactly, including error messages, code, labels, numbers, and URLs.",
  "Describe the layout, the main elements, their state, and anything that looks wrong or notable, focusing on what the stated purpose needs.",
  "Be complete but concise. Do not guess at text you cannot read; say it is unreadable.",
  "Describe only what the image shows; do not comment on why it was sent or what the user intends.",
].join("\n");
const MEDIA_PROMPT = [
  "You answer questions about an attached video or audio file for an AI coding agent that cannot play it.",
  "Transcribe speech and on-screen text exactly. Describe what happens, in order, with approximate timestamps when they help.",
  "Say plainly when something is unclear or inaudible instead of guessing.",
].join("\n");

const DESCRIBE_TIMEOUT_MS = 120_000;
// A tool can return many screenshots at once; bound the parallel description calls.
const DESCRIBE_CONCURRENCY = 4;
const MEDIA_TIMEOUT_MS = 300_000;
const MAX_ANSWER_TOKENS = 8_000;
const STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const VIEW_FALLBACK_RESIZE = { maxWidth: 1568, maxHeight: 1568, maxBytes: 1_000_000 };
const OWN_TOOLS = new Set(["ask_image", "view_image", "ask_video", "ask_audio"]);

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
// Formats every provider accepts; others are converted to PNG before a model sees them.
const PROVIDER_FORMATS = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
// sharp format names for images it can read that providers do not accept.
const OTHER_IMAGE_FORMATS: Record<string, string> = { tiff: "image/tiff", heif: "image/avif", svg: "image/svg+xml" };
const EXTENSION_FOR_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
// Formats Gemini documents for inline video and audio.
const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  mpg: "video/mpeg",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  flv: "video/x-flv",
  webm: "video/webm",
  wmv: "video/x-ms-wmv",
  "3gp": "video/3gpp",
};
const AUDIO_MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  aiff: "audio/aiff",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

const extensionOf = (file: string) => path.extname(file).slice(1).toLowerCase();

function storeDir(): string {
  return path.join(getAgentDir(), "media-understanding");
}

/** Keep a copy so later questions see this image even if the source file changes. */
function storeImage(image: ImageContent, original?: { bytes: Buffer; extension: string }): string {
  const dir = storeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bytes = original?.bytes ?? Buffer.from(image.data, "base64");
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  const file = path.join(dir, `${hash}.${original?.extension ?? EXTENSION_FOR_MIME[image.mimeType] ?? "img"}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { mode: 0o600 });
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

function readFileChecked(cwd: string, requested: string): { file: string; bytes: Buffer } {
  const file = path.resolve(cwd, requested);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  if (!fs.statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
  return { file, bytes: fs.readFileSync(file) };
}

/** Image bytes with their real type, which can differ from the file extension. */
async function readImageFile(
  cwd: string,
  requested: string,
): Promise<{ file: string; bytes: Buffer; mimeType: string }> {
  const { file, bytes } = readFileChecked(cwd, requested);
  const format = await (
    await loadSharp()
  )(bytes)
    .metadata()
    .then((meta) => meta.format)
    .catch(() => undefined);
  const mimeType = format === "jpeg" ? "image/jpeg" : format && (IMAGE_MIME[format] ?? OTHER_IMAGE_FORMATS[format]);
  if (!mimeType) {
    throw new Error(
      `Cannot read ${file} as an image (png, jpg, webp, gif, tiff, avif, svg). iPhone HEIC photos need converting first, for example to jpg.`,
    );
  }
  return { file, bytes, mimeType };
}

/** PNG for formats providers reject, so a model never receives an image it cannot read. */
async function providerSafe(image: ImageContent): Promise<ImageContent> {
  if (PROVIDER_FORMATS.has(image.mimeType)) return image;
  const png = await (
    await loadSharp()
  )(Buffer.from(image.data, "base64"))
    .rotate()
    .png()
    .toBuffer()
    .catch(() => undefined);
  if (!png) {
    throw new Error(
      `Cannot convert a ${image.mimeType} image for the model. iPhone HEIC photos need converting first.`,
    );
  }
  return { type: "image", data: png.toString("base64"), mimeType: "image/png" };
}

type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp> | undefined;
const loadSharp = (): Promise<Sharp> => (sharpModule ??= import("sharp").then((module) => module.default));

const regionSchema = Type.Optional(
  Type.Array(Type.Integer({ minimum: 0 }), {
    minItems: 4,
    maxItems: 4,
    description:
      "Optional [x1, y1, x2, y2] crop in the original image's pixels, kept at full resolution. Use it to zoom into small text or detail; a size note gives the scale.",
  }),
);

/** Crop `[x1, y1, x2, y2]` from the displayed (EXIF-rotated) image at full resolution. */
export async function cropImage(
  bytes: Buffer,
  region: number[],
): Promise<{ image: ImageContent; width: number; height: number; note: string }> {
  const sharp = await loadSharp();
  const rotated = await sharp(bytes).rotate().png().toBuffer({ resolveWithObject: true });
  const { width: fullWidth, height: fullHeight } = rotated.info;
  const [x1, y1, x2, y2] = region as [number, number, number, number];
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.min(fullWidth, Math.max(x1, x2));
  const bottom = Math.min(fullHeight, Math.max(y1, y2));
  if (right - left < 1 || bottom - top < 1) {
    throw new Error(`Region ${JSON.stringify(region)} is outside the ${fullWidth}x${fullHeight} image.`);
  }
  const crop = await sharp(rotated.data)
    .extract({ left, top, width: right - left, height: bottom - top })
    .png()
    .toBuffer();
  return {
    image: { type: "image", data: crop.toString("base64"), mimeType: "image/png" },
    width: right - left,
    height: bottom - top,
    note: `[Region ${left},${top} to ${right},${bottom} of the ${fullWidth}x${fullHeight} original.]`,
  };
}

function resolveModel(ctx: ExtensionContext, model: string, label: string): Model<Api> {
  const [provider, ...rest] = model.split("/");
  const found = rest.length ? ctx.modelRegistry.find(provider!, rest.join("/")) : undefined;
  if (!found) throw new Error(`The ${label} model "${model}" is not in the model registry.`);
  return found;
}

/** Ask the configured image model about one image. */
export async function askVisionModel(
  ctx: ExtensionContext,
  choice: ModelChoice,
  image: ImageContent,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const model = resolveModel(ctx, choice.model, "image");
  if (!model.input.includes("image")) throw new Error(`Model "${choice.model}" does not accept images.`);
  // Attachments arrive before Pi resizes them, and saved originals are full size; fit the copy sent to the
  // helper within its own image limits so large photos are not rejected or uploaded at full size.
  const readable = await providerSafe(image);
  const fitted = await resizeImage(
    Buffer.from(readable.data, "base64"),
    readable.mimeType,
    model.inputLimits?.images?.resize ?? VIEW_FALLBACK_RESIZE,
  ).catch(() => null);
  const sent: ImageContent = fitted ? { type: "image", data: fitted.data, mimeType: fitted.mimeType } : readable;
  const timeout = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
  const options: Record<string, unknown> = {
    maxTokens: Math.min(MAX_ANSWER_TOKENS, model.maxTokens || MAX_ANSWER_TOKENS),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    cacheRetention: "none",
  };
  if (model.reasoning && choice.thinkingLevel !== "off") options.reasoning = choice.thinkingLevel;
  const response = await ctx.modelRegistry
    .streamSimple(
      model,
      {
        systemPrompt: IMAGE_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, sent], timestamp: Date.now() }],
      },
      options as any,
    )
    .result();
  if (response.stopReason !== "stop" && response.stopReason !== "length") {
    throw new Error(response.errorMessage || `Image model stopped with "${response.stopReason}".`);
  }
  const text = response.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Image model returned no answer.");
  return text;
}

/**
 * Ask the configured model about a video or audio file. Pi's request types
 * carry only text and images, so this sends an OpenAI Responses request with
 * the file as an `input_file` data URL, using Pi's credentials for the model.
 */
export async function askMediaModel(
  ctx: ExtensionContext,
  choice: ModelChoice,
  kind: "video" | "audio",
  file: { name: string; bytes: Buffer; mimeType: string },
  question: string,
  signal?: AbortSignal,
): Promise<string> {
  const model = resolveModel(ctx, choice.model, kind);
  if (model.api !== "openai-responses") {
    throw new Error(`The ${kind} model must use the OpenAI Responses API; "${choice.model}" uses ${model.api}.`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const mapped = choice.thinkingLevel === "off" ? undefined : model.thinkingLevelMap?.[choice.thinkingLevel];
  const effort =
    model.reasoning && choice.thinkingLevel !== "off" && mapped !== null ? (mapped ?? choice.thinkingLevel) : undefined;
  const timeout = AbortSignal.timeout(MEDIA_TIMEOUT_MS);
  const response = await fetch(`${(auth.baseUrl ?? model.baseUrl).replace(/\/+$/, "")}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}),
      ...model.headers,
      ...auth.headers,
    },
    body: JSON.stringify({
      model: model.id,
      stream: false,
      store: false,
      instructions: MEDIA_PROMPT,
      max_output_tokens: Math.min(MAX_ANSWER_TOKENS, model.maxTokens || MAX_ANSWER_TOKENS),
      ...(effort ? { reasoning: { effort } } : {}),
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: question },
            {
              type: "input_file",
              filename: file.name,
              file_data: `data:${file.mimeType};base64,${file.bytes.toString("base64")}`,
            },
          ],
        },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = (await response.json().catch(() => undefined)) as any;
  if (!response.ok) {
    const detail = body?.error?.message ?? (body ? JSON.stringify(body).slice(0, 300) : response.statusText);
    throw new Error(`The ${kind} model returned HTTP ${response.status}: ${detail}`);
  }
  const text = (body?.output ?? [])
    .flatMap((item: any) => item?.content ?? [])
    .filter((part: any) => part?.type === "output_text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
  if (!text) throw new Error(`The ${kind} model returned no answer.`);
  return text;
}

function descriptionBlock(model: string, file: string, description: string, tools: string[]): string {
  const label = model.split("/").pop() ?? model;
  const hint = tools.length ? ` Use ${tools.join(" or ")} for a closer look.` : "";
  return `[Image described by ${label}; saved at ${file}.${hint}]\n${description}`;
}

async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function excerpt(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

export default function mediaUnderstanding(pi: ExtensionAPI) {
  const config = loadConfig();
  const { images, video, audio } = config;
  const describe = images.describeOnArrival !== "off" && images.model !== "";
  const askImage = images.enabled && images.model !== "";
  const askVideo = video.enabled && video.model !== "";
  const askAudio = audio.enabled && audio.model !== "";
  if (!images.enabled && !describe && !askVideo && !askAudio) return;

  let lastUserText = "";
  const views = new Map<string, number>();
  const followUpTools = [...(askImage ? ["ask_image"] : []), ...(images.enabled ? ["view_image"] : [])];

  pi.on("session_start", (_event, ctx) => {
    views.clear();
    const missing = [
      (video.enabled && !askVideo && "video") || "",
      (audio.enabled && !askAudio && "audio") || "",
      (images.describeOnArrival !== "off" && !describe && "image descriptions") || "",
    ].filter(Boolean);
    if (missing.length && ctx.hasUI)
      ctx.ui.notify(`Media Understanding: no model set for ${missing.join(", ")}.`, "warning");
    try {
      pruneStore();
    } catch {
      // Pruning is housekeeping; a failure must not block the session.
    }
  });

  if (describe) {
    // "auto" keeps real images for models that can see them.
    const shouldDescribe = (ctx: ExtensionContext) =>
      images.describeOnArrival === "always" || !ctx.model?.input.includes("image");

    /** Describe each image; an image whose description fails stays an image. */
    const describeAll = (
      ctx: ExtensionContext,
      list: ImageContent[],
      purpose: string,
      original?: { bytes: Buffer; extension: string },
    ): Promise<Array<{ image: ImageContent; text?: string }>> =>
      mapLimited(list, DESCRIBE_CONCURRENCY, async (image) => {
        try {
          const file = storeImage(image, list.length === 1 ? original : undefined);
          const description = await askVisionModel(ctx, images, image, purpose, ctx.signal);
          return { image, text: descriptionBlock(images.model, file, description, followUpTools) };
        } catch (error) {
          if (ctx.signal?.aborted) throw error;
          if (ctx.hasUI)
            ctx.ui.notify(`Image left as is: ${error instanceof Error ? error.message : String(error)}`, "warning");
          return { image };
        }
      });

    pi.on("input", async (event, ctx) => {
      // Input Mode resends interrupting or follow-up input as an extension message; it is still the user's.
      lastUserText = event.text;
      if (!event.images?.length || !shouldDescribe(ctx)) return { action: "continue" };
      const purpose = `The user attached this image to their message:\n"""\n${excerpt(event.text, 4_000) || "(no text)"}\n"""`;
      const results = await describeAll(ctx, event.images, purpose);
      if (results.every((result) => result.text === undefined)) return { action: "continue" };
      return {
        action: "transform",
        text: [event.text, ...results.flatMap((result) => (result.text ? [result.text] : []))]
          .filter(Boolean)
          .join("\n\n"),
        images: results.filter((result) => result.text === undefined).map((result) => result.image),
      };
    });

    pi.on("tool_result", async (event, ctx) => {
      // Nested calls return to a script, not the conversation; the script's own result is handled.
      if (OWN_TOOLS.has(event.toolName) || event.parentToolCallId || !shouldDescribe(ctx)) return undefined;
      const list = event.content.filter((block): block is ImageContent => block.type === "image");
      if (list.length === 0) return undefined;
      // A read result is a resized copy; keep the original file so zooming has full resolution.
      let original: { bytes: Buffer; extension: string } | undefined;
      const requested = event.toolName === "read" ? event.input.path : undefined;
      if (typeof requested === "string" && IMAGE_MIME[extensionOf(requested)]) {
        try {
          original = { bytes: fs.readFileSync(path.resolve(ctx.cwd, requested)), extension: extensionOf(requested) };
        } catch {
          original = undefined;
        }
      }
      const purpose = [
        `The agent received this image from the ${event.toolName} tool with input ${excerpt(JSON.stringify(event.input), 1_000)}.`,
        lastUserText ? `The user's latest request:\n"""\n${excerpt(lastUserText, 4_000)}\n"""` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const results = await describeAll(ctx, list, purpose, original);
      if (results.every((result) => result.text === undefined)) return undefined;
      const described = new Map(results.map((result) => [result.image, result.text]));
      return {
        content: event.content.map((block): TextContent | ImageContent => {
          const text = block.type === "image" ? described.get(block) : undefined;
          return text ? { type: "text", text } : block;
        }),
        // A structured result does not carry the image itself; Pi drops it unless returned.
        ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
      };
    });
  } else {
    pi.on("input", (event) => {
      lastUserText = event.text;
      return { action: "continue" };
    });
  }

  if (images.enabled) {
    pi.registerTool({
      name: "view_image",
      label: "View Image",
      description:
        "Show an image file to you directly, optionally zoomed to a region at full resolution. Descriptions can miss visual detail: view the image when the question depends on how it looks (layout, color, alignment, quality) or a description seems wrong." +
        (askImage ? " For text or details, ask_image keeps the conversation smaller." : ""),
      exposure: "model-only",
      annotations: { readOnlyHint: true, openWorldHint: false },
      parameters: Type.Object({
        path: Type.String({ description: "Image file path." }),
        region: regionSchema,
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (ctx.model && !ctx.model.input.includes("image")) {
          throw new Error(
            `The current model cannot see images${askImage ? "; use ask_image to ask about it instead" : ""}.`,
          );
        }
        const source = await readImageFile(ctx.cwd, params.path);
        const key = `${createHash("sha256").update(source.bytes).digest("hex")}:${params.region?.join(",") ?? "full"}`;
        const count = (views.get(key) ?? 0) + 1;
        if (config.maxViewsPerImage > 0 && count > config.maxViewsPerImage) {
          throw new Error(
            `This image${params.region ? " region" : ""} was already shown ${config.maxViewsPerImage} times in this session; use the earlier view or a different region.`,
          );
        }
        const notes: string[] = [];
        const readable = await providerSafe({
          type: "image",
          data: source.bytes.toString("base64"),
          mimeType: source.mimeType,
        });
        let bytes = Buffer.from(readable.data, "base64");
        let mimeType = readable.mimeType;
        if (params.region) {
          const crop = await cropImage(source.bytes, params.region);
          bytes = Buffer.from(crop.image.data, "base64");
          mimeType = crop.image.mimeType;
          notes.push(crop.note);
        }
        const resized = await resizeImage(
          bytes,
          mimeType,
          ctx.model?.inputLimits?.images?.resize ?? VIEW_FALLBACK_RESIZE,
        );
        const shown: ImageContent = resized
          ? { type: "image", data: resized.data, mimeType: resized.mimeType }
          : { type: "image", data: bytes.toString("base64"), mimeType };
        const dimensionNote = resized ? formatDimensionNote(resized) : undefined;
        if (dimensionNote) notes.push(dimensionNote);
        // Only a view that succeeded counts toward the repeat cap.
        views.set(key, count);
        return {
          content: [{ type: "text", text: [`Image ${params.path}:`, ...notes].join("\n") }, shown],
          details: { path: params.path, region: params.region, width: resized?.width, height: resized?.height },
        };
      },
    });
  }

  if (askImage) {
    pi.registerTool({
      name: "ask_image",
      label: "Ask About Image",
      description:
        "Ask the image model a question about an image file, optionally about a region at full resolution. Use it to read text or check details; only the answer enters the conversation.",
      exposure: "model-only",
      annotations: { readOnlyHint: true, openWorldHint: true },
      parameters: Type.Object({
        path: Type.String({ description: "Image file path." }),
        question: Type.String({ description: "What to find out about the image." }),
        region: regionSchema,
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const source = await readImageFile(ctx.cwd, params.path);
        const crop = params.region ? await cropImage(source.bytes, params.region) : undefined;
        const image: ImageContent = crop?.image ?? {
          type: "image",
          data: source.bytes.toString("base64"),
          mimeType: source.mimeType,
        };
        const answer = await askVisionModel(ctx, images, image, params.question, signal);
        return {
          content: [{ type: "text", text: crop ? `${crop.note}\n${answer}` : answer }],
          details: { path: params.path, region: params.region },
        };
      },
    });
  }

  const registerMediaTool = (kind: "video" | "audio", choice: ModelChoice, formats: Record<string, string>) => {
    const name = kind === "video" ? "ask_video" : "ask_audio";
    pi.registerTool({
      name,
      label: kind === "video" ? "Ask About Video" : "Ask About Audio",
      description:
        kind === "video"
          ? "Ask the video model about a video file: what happens, on-screen text, speech, or whether it matches what was intended."
          : "Ask the audio model about an audio file, such as transcribing speech or describing sounds.",
      exposure: "model-only",
      annotations: { readOnlyHint: true, openWorldHint: true },
      parameters: Type.Object({
        path: Type.String({ description: `${kind === "video" ? "Video" : "Audio"} file path.` }),
        question: Type.String({ description: "What to find out." }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const file = path.resolve(ctx.cwd, params.path);
        if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
        if (!fs.statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
        const extension = extensionOf(file);
        const mimeType = formats[extension];
        if (!mimeType) {
          throw new Error(
            `Unsupported ${kind} format ".${extension}". Supported: ${Object.keys(formats).join(", ")}. Convert with ffmpeg first.`,
          );
        }
        const size = fs.statSync(file).size;
        if (size > config.maxFileMB * 1024 * 1024) {
          throw new Error(
            `${path.basename(file)} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${config.maxFileMB} MB limit. Trim or compress it with ffmpeg and ask about the smaller file.`,
          );
        }
        const answer = await askMediaModel(
          ctx,
          choice,
          kind,
          { name: path.basename(file), bytes: fs.readFileSync(file), mimeType },
          params.question,
          signal,
        );
        return { content: [{ type: "text", text: answer }], details: { path: params.path, bytes: size } };
      },
    });
  };
  if (askVideo) registerMediaTool("video", video, VIDEO_MIME);
  if (askAudio) registerMediaTool("audio", audio, AUDIO_MIME);
}
