import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import sharp from "sharp";
import webpImages, { DEFAULT_CONFIG, acceptsWebp, loadConfig } from "./index.ts";

const noise = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } },
  });
// A compressible picture with gradients, shapes, and text, closer to a screenshot or photo than noise.
const scene = (width: number, height: number) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
        `<defs><linearGradient id="g"><stop offset="0" stop-color="#1e3a8a"/><stop offset="1" stop-color="#f59e0b"/></linearGradient></defs>` +
        `<rect width="100%" height="100%" fill="url(#g)"/><circle cx="30%" cy="40%" r="20%" fill="#10b981"/>` +
        `<text x="10" y="60" font-size="48" fill="white">Invalid password</text></svg>`,
    ),
  );
const block = (bytes: Buffer, mimeType: string) => ({
  type: "image" as const,
  data: bytes.toString("base64"),
  mimeType,
});
const size = async (image: { data: string }) => {
  const meta = await sharp(Buffer.from(image.data, "base64")).metadata();
  return { width: meta.width, height: meta.height, format: meta.format };
};

function withAgentDir(config: unknown, run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webp-images-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    if (config !== undefined) fs.writeFileSync(path.join(dir, "webp-images.json"), JSON.stringify(config));
    try {
      await run(dir);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(model?: object, cwd = process.cwd()) {
  const hooks = new Map<string, (...args: any[]) => any>();
  const notices: string[] = [];
  webpImages({ on: (name: string, handler: any) => hooks.set(name, handler) } as never);
  const ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) }, cwd, model };
  return { hooks, notices, ctx };
}

test(
  "is off by default and then only keeps WebP images working for models that reject them",
  withAgentDir(undefined, () => {
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
    const app = harness();
    assert.deepEqual([...app.hooks.keys()], ["context"]);
    assert.equal(acceptsWebp({ provider: "cliproxy-responses", id: "factory/claude-haiku-5-5" }, DEFAULT_CONFIG), true);
    assert.equal(acceptsWebp({ provider: "cliproxy-responses", id: "xai/grok-4.7" }, DEFAULT_CONFIG), false);
  }),
);

test(
  "converts tool-result images to smaller WebP and keeps GIFs and structured results",
  withAgentDir({ enabled: true }, async () => {
    const app = harness();
    const png = await noise(1200, 800).png().toBuffer();
    const gif = await noise(40, 40).gif().toBuffer();
    const event = {
      toolName: "screenshot",
      toolCallId: "1",
      input: {},
      content: [{ type: "text", text: "shot" }, block(png, "image/png"), block(gif, "image/gif")],
      structuredContent: { ok: true },
    };
    const result = await app.hooks.get("tool_result")!(event, app.ctx);
    assert.equal(result.content[1].mimeType, "image/webp");
    assert.ok(Buffer.from(result.content[1].data, "base64").length < png.length);
    assert.deepEqual(await size(result.content[1]), { width: 1200, height: 800, format: "webp" });
    assert.equal(result.content[2], event.content[2], "GIFs may be animated, so they stay as they are");
    assert.deepEqual(result.structuredContent, { ok: true });
    assert.equal(await app.hooks.get("tool_result")!({ ...event, parentToolCallId: "0" }, app.ctx), undefined);
  }),
);

test(
  "re-encodes a read image from its original file, honoring EXIF rotation, and ignores a mismatched file",
  withAgentDir({ enabled: true }, async (dir) => {
    // Stored 800x600 with orientation 6, so it displays as 600x800, like a phone photo.
    const photo = await scene(800, 600).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
    fs.writeFileSync(path.join(dir, "photo.jpg"), photo);
    const piCopy = await sharp(photo).rotate().resize(300, 400).jpeg({ quality: 80 }).toBuffer();
    const app = harness(undefined, dir);
    const read = (file: string) =>
      app.hooks.get("tool_result")!(
        { toolName: "read", toolCallId: "2", input: { path: file }, content: [block(piCopy, "image/jpeg")] },
        app.ctx,
      );
    const result = await read("photo.jpg");
    assert.deepEqual(await size(result.content[0]), { width: 300, height: 400, format: "webp" });

    fs.writeFileSync(path.join(dir, "wide.png"), await scene(1000, 200).png().toBuffer());
    const mismatched = await read("wide.png");
    assert.deepEqual(await size(mismatched.content[0]), { width: 300, height: 400, format: "webp" });
  }),
);

test(
  "fits attachments to the model's image limits and leaves animated images alone",
  withAgentDir({ enabled: true }, async () => {
    const app = harness({
      provider: "p",
      id: "claude",
      inputLimits: { images: { resize: { maxWidth: 500, maxHeight: 500 } } },
    });
    const attached = block(await noise(1200, 800).png().toBuffer(), "image/png");
    const frames = await Promise.all([noise(64, 64).png().toBuffer(), noise(64, 64).png().toBuffer()]);
    const animated = block(
      await sharp(frames, { join: { animated: true } })
        .webp()
        .toBuffer(),
      "image/webp",
    );
    const result = await app.hooks.get("input")!(
      { text: "look", images: [attached, animated], source: "interactive" },
      app.ctx,
    );
    assert.equal(result.action, "transform");
    assert.deepEqual(await size(result.images[0]), { width: 500, height: 333, format: "webp" });
    assert.equal(result.images[1], animated);
    assert.equal(
      result.text,
      "look\n\n[Image: original 1200x800, displayed at 500x333. Multiply coordinates by 2.40 to map to original image.]",
    );

    const shot = await app.hooks.get("tool_result")!(
      { toolName: "screenshot", toolCallId: "3", input: {}, content: [attached] },
      app.ctx,
    );
    assert.equal(shot.content[0].mimeType, "image/webp");
    assert.match(
      shot.content[1].text,
      /^\[Image: original 1200x800, displayed at 500x333\./,
      "the resize note follows its image",
    );
    // Providers reject SVG and Pi cannot convert it, so it becomes WebP even though the SVG is smaller.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="red"/></svg>',
    );
    const fromSvg = await app.hooks.get("input")!(
      { text: "logo", images: [block(svg, "image/svg+xml")], source: "interactive" },
      app.ctx,
    );
    assert.deepEqual(await size(fromSvg.images[0]), { width: 120, height: 60, format: "webp" });

    // Input Mode resends interrupting input as an extension message; its images are converted too.
    const resent = await app.hooks.get("input")!({ text: "x", images: [attached], source: "extension" }, app.ctx);
    assert.equal(resent.images[0].mimeType, "image/webp");
    // A WebP already within the limits is left alone instead of losing quality to a second encode.
    assert.deepEqual(
      await app.hooks.get("input")!({ text: "x", images: [resent.images[0]], source: "interactive" }, app.ctx),
      {
        action: "continue",
      },
    );
  }),
);

test(
  "sends WebP as identical JPEG or PNG bytes to models outside webpModels",
  withAgentDir(undefined, async () => {
    const opaque = block(await noise(200, 100).webp().toBuffer(), "image/webp");
    const transparent = block(
      await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } })
        .webp()
        .toBuffer(),
      "image/webp",
    );
    const messages = () => [
      { role: "user", content: [{ type: "text", text: "hi" }, opaque] },
      { role: "toolResult", content: [transparent] },
    ];
    const grok = harness({ provider: "cliproxy-responses", id: "xai/grok-4.7" });
    const first = await grok.hooks.get("context")!({ messages: messages() }, grok.ctx);
    assert.equal(first.messages[0].content[1].mimeType, "image/jpeg");
    assert.equal(first.messages[1].content[0].mimeType, "image/png", "transparency needs PNG");
    const second = await grok.hooks.get("context")!({ messages: messages() }, grok.ctx);
    assert.equal(second.messages[0].content[1].data, first.messages[0].content[1].data, "stable bytes keep the cache");

    const claude = harness({ provider: "cliproxy-responses", id: "factory/claude-opus-5-5" });
    assert.equal(await claude.hooks.get("context")!({ messages: messages() }, claude.ctx), undefined);
  }),
);
