import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";

/**
 * Re-encodes images as lossy WebP when they enter the conversation. Each image
 * is converted once, before it is stored, so earlier requests never change and
 * the prompt cache keeps working. Off unless enabled in webp-images.json.
 *
 * Some providers (xAI documents JPEG and PNG only) reject WebP, so requests to
 * models outside `webpModels` carry WebP images as JPEG or PNG instead. That
 * fallback runs even when conversion is off, because sessions keep their WebP
 * images and users can attach WebP files themselves.
 */

export interface WebpImagesConfig {
  enabled: boolean;
  /** WebP quality, 1-100. */
  quality: number;
  /** Case-insensitive substrings of "provider/model-id" for models that accept WebP. */
  webpModels: string[];
}

export const DEFAULT_CONFIG: WebpImagesConfig = {
  enabled: false,
  quality: 80,
  webpModels: ["claude", "gpt", "gemini"],
};

export function configPath(): string {
  return path.join(getAgentDir(), "webp-images.json");
}

export function loadConfig(file = configPath()): WebpImagesConfig {
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<WebpImagesConfig>;
    const quality =
      typeof raw.quality === "number" && Number.isFinite(raw.quality)
        ? Math.min(100, Math.max(1, Math.round(raw.quality)))
        : DEFAULT_CONFIG.quality;
    const webpModels = Array.isArray(raw.webpModels)
      ? raw.webpModels.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
      : DEFAULT_CONFIG.webpModels;
    return { enabled: raw.enabled === true, quality, webpModels: webpModels.map((entry) => entry.trim()) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Pi's built-in limits when the model catalog sets none (utils/image-resize-core.ts). */
const PI_DEFAULT_LIMITS = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };
// GIFs may be animated, and WebP output keeps only the first frame.
const CONVERTIBLE = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
const FALLBACK_JPEG_QUALITY = 90;
const FALLBACK_CACHE_ENTRIES = 256;

type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp> | undefined;
const loadSharp = (): Promise<Sharp> => (sharpModule ??= import("sharp").then((module) => module.default));

interface Limits {
  maxWidth: number;
  maxHeight: number;
  maxBytes: number;
}

function limitsFor(ctx: Pick<ExtensionContext, "model">): Limits {
  const resize = ctx.model?.inputLimits?.images?.resize;
  return {
    maxWidth: resize?.maxWidth ?? PI_DEFAULT_LIMITS.maxWidth,
    maxHeight: resize?.maxHeight ?? PI_DEFAULT_LIMITS.maxHeight,
    maxBytes: resize?.maxBytes ?? PI_DEFAULT_LIMITS.maxBytes,
  };
}

const baseMime = (mimeType: string) => mimeType.split(";")[0]!.trim().toLowerCase();
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/** Width and height as displayed, after the EXIF orientation is applied. */
function orientedSize(meta: { width?: number; height?: number; orientation?: number }) {
  if (!meta.width || !meta.height) return undefined;
  const swapped = (meta.orientation ?? 1) >= 5;
  return swapped ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

/**
 * Convert one image to WebP. `source` is the original file behind a resized
 * copy, so the WebP is encoded from full-quality pixels at the copy's size.
 * Returns the block itself whenever conversion would not help or could make Pi
 * re-encode it: unsupported or animated input, a result that is not smaller,
 * or one over the model's limits.
 */
export async function convertImage(
  image: ImageContent,
  quality: number,
  limits: Limits,
  source?: Buffer,
): Promise<ImageContent> {
  if (!CONVERTIBLE.has(baseMime(image.mimeType))) return image;
  const sharp = await loadSharp();
  const current = Buffer.from(image.data, "base64");
  const currentMeta = await sharp(current).metadata();
  if ((currentMeta.pages ?? 1) > 1) return image;
  const currentSize = orientedSize(currentMeta);
  if (!currentSize) return image;

  let pipeline: import("sharp").Sharp | undefined;
  if (source) {
    const sourceMeta = await sharp(source)
      .metadata()
      .catch(() => undefined);
    const sourceSize = sourceMeta && (sourceMeta.pages ?? 1) === 1 ? orientedSize(sourceMeta) : undefined;
    // Only a source with the copy's shape is the same picture; otherwise encode the copy itself.
    if (
      sourceSize &&
      Math.abs(sourceSize.width / sourceSize.height - currentSize.width / currentSize.height) <
        0.02 * (currentSize.width / currentSize.height)
    ) {
      pipeline = sharp(source).rotate().resize(currentSize.width, currentSize.height, { fit: "fill" });
    }
  }
  pipeline ??= sharp(current)
    .rotate()
    .resize({ width: limits.maxWidth, height: limits.maxHeight, fit: "inside", withoutEnlargement: true });

  const webp = await pipeline.webp({ quality }).toBuffer();
  if (webp.length >= current.length || base64Length(webp.length) >= limits.maxBytes) return image;
  return { type: "image", data: webp.toString("base64"), mimeType: "image/webp" };
}

/** The original file behind a `read` result, when it is an image file. */
function readSource(ctx: ExtensionContext, toolName: string, input: Record<string, unknown>): Buffer | undefined {
  if (toolName !== "read" || typeof input.path !== "string" || !IMAGE_FILE.test(input.path)) return undefined;
  try {
    return fs.readFileSync(path.resolve(ctx.cwd, input.path));
  } catch {
    return undefined;
  }
}

export function acceptsWebp(model: { provider: string; id: string } | undefined, config: WebpImagesConfig): boolean {
  if (!model) return true;
  const name = `${model.provider}/${model.id}`.toLowerCase();
  return config.webpModels.some((entry) => name.includes(entry.toLowerCase()));
}

export default function webpImages(pi: ExtensionAPI) {
  const config = loadConfig();
  let sharpFailed = false;
  // Deterministic per image, so repeated requests send identical bytes and keep the prompt cache.
  const fallbackCache = new Map<string, ImageContent>();

  const reportFailure = (ctx: ExtensionContext, error: unknown, what: string) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/Cannot find (module|package)|Could not load the "sharp" module/i.test(message)) {
      if (sharpFailed) return;
      sharpFailed = true;
      if (ctx.hasUI)
        ctx.ui.notify(`WebP Images is inactive: the sharp image library could not load (${message}).`, "warning");
      return;
    }
    if (ctx.hasUI) ctx.ui.notify(`${what}: ${message}`, "warning");
  };

  const convertAll = (ctx: ExtensionContext, images: ImageContent[], source?: Buffer) => {
    const limits = limitsFor(ctx);
    return Promise.all(
      images.map((image) =>
        sharpFailed
          ? image
          : convertImage(image, config.quality, limits, source).catch((error: unknown) => {
              reportFailure(ctx, error, `Image kept as ${image.mimeType}`);
              return image;
            }),
      ),
    );
  };

  const toProviderFormat = async (image: ImageContent): Promise<ImageContent> => {
    const key = createHash("sha256").update(image.data).digest("hex");
    const cached = fallbackCache.get(key);
    if (cached) return cached;
    const sharp = await loadSharp();
    const input = sharp(Buffer.from(image.data, "base64"));
    const { hasAlpha } = await input.metadata();
    // JPEG has no transparency; PNG keeps it.
    const bytes = hasAlpha
      ? await input.png().toBuffer()
      : await input.jpeg({ quality: FALLBACK_JPEG_QUALITY }).toBuffer();
    const converted: ImageContent = {
      type: "image",
      data: bytes.toString("base64"),
      mimeType: hasAlpha ? "image/png" : "image/jpeg",
    };
    if (fallbackCache.size >= FALLBACK_CACHE_ENTRIES) fallbackCache.delete(fallbackCache.keys().next().value!);
    fallbackCache.set(key, converted);
    return converted;
  };

  pi.on("context", async (event, ctx) => {
    if (sharpFailed || acceptsWebp(ctx.model, config)) return undefined;
    let changed = false;
    for (const message of event.messages as Array<{ content?: unknown }>) {
      if (!Array.isArray(message.content)) continue;
      for (let index = 0; index < message.content.length; index++) {
        const block = message.content[index] as ImageContent;
        if (block?.type !== "image" || baseMime(block.mimeType) !== "image/webp") continue;
        try {
          message.content[index] = await toProviderFormat(block);
          changed = true;
        } catch (error) {
          reportFailure(ctx, error, "A WebP image could not be converted for this model");
        }
      }
    }
    return changed ? { messages: event.messages } : undefined;
  });

  if (!config.enabled) return;

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !event.images?.length) return { action: "continue" };
    const images = await convertAll(ctx, event.images);
    if (images.every((image, index) => image === event.images![index])) return { action: "continue" };
    return { action: "transform", text: event.text, images };
  });

  pi.on("tool_result", async (event, ctx) => {
    // Nested calls return to a script, not the conversation; the script's own result is converted.
    if (event.parentToolCallId) return undefined;
    const images = event.content.filter((block): block is ImageContent => block.type === "image");
    if (images.length === 0) return undefined;
    // One read returns one image; its original file gives the cleanest encode.
    const source = images.length === 1 ? readSource(ctx, event.toolName, event.input) : undefined;
    const converted = await convertAll(ctx, images, source);
    if (converted.every((image, index) => image === images[index])) return undefined;
    const replacements = new Map(images.map((image, index) => [image, converted[index]!]));
    return {
      content: event.content.map((block) => (block.type === "image" ? (replacements.get(block) ?? block) : block)),
      // Only the encoding changed, so a structured result still matches; Pi drops it unless returned.
      ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
    };
  });
}
