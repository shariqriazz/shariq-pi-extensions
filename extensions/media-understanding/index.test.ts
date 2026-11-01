import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import sharp from "sharp";
import mediaUnderstanding, { DEFAULT_CONFIG, loadConfig } from "./index.ts";

const PNG = { type: "image" as const, data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" };
const VISION = {
  provider: "vision",
  id: "flash",
  api: "openai-responses",
  input: ["text", "image"],
  reasoning: true,
  maxTokens: 8_000,
};
const TEXT_ONLY = {
  provider: "text",
  id: "glm",
  api: "openai-responses",
  input: ["text"],
  reasoning: false,
  maxTokens: 8_000,
};

function withAgentDir(config: unknown, run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-media-understanding-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    if (config !== undefined) fs.writeFileSync(path.join(dir, "media-understanding.json"), JSON.stringify(config));
    try {
      await run(dir);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(
  reply: (prompt: string) => { text?: string; error?: string },
  model: object = VISION,
  cwd = process.cwd(),
) {
  const hooks = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const prompts: string[] = [];
  const sentImages: Array<{ data: string; mimeType: string }> = [];
  const notices: string[] = [];
  mediaUnderstanding({
    on: (name: string, handler: any) => hooks.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as never);
  const media = {
    ...VISION,
    provider: "media",
    id: "gemini",
    baseUrl: "http://proxy.test/v1/",
    thinkingLevelMap: { low: "minimal-ish" },
  };
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    cwd,
    model,
    modelRegistry: {
      find: (provider: string, id: string) =>
        provider === "vision" && id === "flash" ? VISION : provider === "media" && id === "gemini" ? media : undefined,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret-key", headers: { "x-extra": "1" } }),
      streamSimple(_model: unknown, context: any, options: any) {
        prompts.push(`${options.reasoning}|${context.messages[0].content[0].text}`);
        sentImages.push(context.messages[0].content[1]);
        const result = reply(context.messages[0].content[0].text);
        return {
          result: async () =>
            result.error
              ? { stopReason: "error", errorMessage: result.error, content: [] }
              : { stopReason: "stop", content: [{ type: "text", text: result.text }] },
        };
      },
    },
  };
  return { hooks, tools, prompts, sentImages, notices, ctx };
}

test(
  "stays off by default, and each part turns on alone",
  withAgentDir(undefined, async (dir) => {
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
    const off = harness(() => ({ text: "unused" }));
    assert.equal(off.hooks.size + off.tools.size, 0);

    fs.writeFileSync(
      path.join(dir, "media-understanding.json"),
      JSON.stringify({ video: { enabled: true, model: "media/gemini" } }),
    );
    assert.deepEqual([...harness(() => ({})).tools.keys()], ["ask_video"]);
    fs.writeFileSync(path.join(dir, "media-understanding.json"), JSON.stringify({ images: { enabled: true } }));
    assert.deepEqual([...harness(() => ({})).tools.keys()], ["view_image"], "ask_image needs a model");
  }),
);

test(
  "always replaces tool-result images with a stored description and keeps failures as images",
  withAgentDir({ images: { enabled: true, model: "vision/flash", describeOnArrival: "always" } }, async (dir) => {
    let fail = false;
    const app = harness(() => (fail ? { error: "quota" } : { text: "A login form with the error: Invalid password." }));
    assert.deepEqual([...app.tools.keys()].sort(), ["ask_image", "view_image"]);
    await app.hooks.get("input")!({ text: "check the login page", source: "interactive" }, app.ctx);
    const event = {
      toolName: "screenshot",
      toolCallId: "1",
      input: { url: "x" },
      content: [{ type: "text", text: "shot" }, PNG],
      structuredContent: { ok: true },
    };
    const result = await app.hooks.get("tool_result")!(event, app.ctx);
    assert.match(result.content[1].text, /Invalid password/);
    const saved = /saved at (\S+)\. Use/.exec(result.content[1].text)![1]!;
    assert.ok(saved.startsWith(dir) && fs.existsSync(saved));
    assert.deepEqual(result.structuredContent, { ok: true });
    assert.match(app.prompts[0]!, /^low\|.*screenshot tool.*check the login page/s);
    assert.equal(await app.hooks.get("tool_result")!({ ...event, toolName: "view_image" }, app.ctx), undefined);
    assert.equal(await app.hooks.get("tool_result")!({ ...event, parentToolCallId: "0" }, app.ctx), undefined);
    fail = true;
    assert.equal(await app.hooks.get("tool_result")!(event, app.ctx), undefined);
    assert.match(app.notices.at(-1)!, /Image left as is: quota/);
  }),
);

test(
  "auto describes only for models that cannot see images",
  withAgentDir({ images: { model: "vision/flash", describeOnArrival: "auto" } }, async () => {
    const message = { text: "what is this?", images: [PNG], source: "interactive" };
    const seeing = harness(() => ({ text: "A chart." }), VISION);
    assert.deepEqual(await seeing.hooks.get("input")!(message, seeing.ctx), { action: "continue" });
    const blind = harness(() => ({ text: "A bar chart of monthly revenue." }), TEXT_ONLY);
    const result = await blind.hooks.get("input")!(message, blind.ctx);
    assert.equal(result.action, "transform");
    assert.deepEqual(result.images, []);
    assert.match(result.text, /^what is this\?\n\n\[Image described by flash; saved at .*\]\nA bar chart/s);
    assert.doesNotMatch(result.text, /ask_image|view_image/, "descriptions name only tools that exist");
  }),
);

test(
  "view_image zooms at full resolution, caps repeats, and refuses for models that cannot see",
  withAgentDir({ images: { enabled: true, model: "vision/flash" }, maxViewsPerImage: 2 }, async (dir) => {
    fs.writeFileSync(
      path.join(dir, "shot.png"),
      await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#336699" } })
        .png()
        .toBuffer(),
    );
    const app = harness(() => ({ text: "unused" }), VISION, dir);
    const view = app.tools.get("view_image")!;
    const zoomed = await view.execute(
      "1",
      { path: "shot.png", region: [100, 50, 500, 250] },
      undefined,
      undefined,
      app.ctx,
    );
    assert.match(zoomed.content[0].text, /Region 100,50 to 500,250 of the 2400x1200 original/);
    const crop = await sharp(Buffer.from(zoomed.content[1].data, "base64")).metadata();
    assert.deepEqual([crop.width, crop.height], [400, 200], "the crop keeps full resolution");

    for (const attempt of ["f1", "f2", "f3"]) {
      await assert.rejects(
        view.execute(attempt, { path: "shot.png", region: [3000, 3000, 3100, 3100] }, undefined, undefined, app.ctx),
        /outside the 2400x1200 image/,
        "a failed view does not count toward the cap",
      );
    }
    const full = await view.execute("2", { path: "shot.png" }, undefined, undefined, app.ctx);
    assert.match(full.content[0].text, /original 2400x1200, displayed at 1568x784/);
    await view.execute("3", { path: "shot.png" }, undefined, undefined, app.ctx);
    await assert.rejects(
      view.execute("4", { path: "shot.png" }, undefined, undefined, app.ctx),
      /already shown 2 times/,
    );

    // A large original is fitted to the helper model's limits before it is sent.
    await app.tools
      .get("ask_image")!
      .execute("q", { path: "shot.png", question: "What color?" }, undefined, undefined, app.ctx);
    const sent = await sharp(Buffer.from(app.sentImages.at(-1)!.data, "base64")).metadata();
    assert.deepEqual([sent.width, sent.height], [1568, 784]);

    // Formats providers reject reach the model as PNG; unreadable files get a clear message.
    fs.writeFileSync(
      path.join(dir, "scan.tiff"),
      await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ffffff" } })
        .tiff()
        .toBuffer(),
    );
    await app.tools.get("ask_image")!.execute("t", { path: "scan.tiff", question: "?" }, undefined, undefined, app.ctx);
    assert.match(app.sentImages.at(-1)!.mimeType, /^image\/(png|jpeg)$/);
    fs.writeFileSync(
      path.join(dir, "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18"/></svg>',
    );
    const svgView = await view.execute("s", { path: "icon.svg" }, undefined, undefined, app.ctx);
    assert.match(svgView.content[1].mimeType, /^image\/(png|jpeg)$/);
    fs.writeFileSync(path.join(dir, "photo.heic"), Buffer.from("not an image"));
    await assert.rejects(
      view.execute("h", { path: "photo.heic" }, undefined, undefined, app.ctx),
      /HEIC photos need converting/,
    );

    const blind = harness(() => ({ text: "unused" }), TEXT_ONLY, dir);
    await assert.rejects(
      blind.tools.get("view_image")!.execute("5", { path: "shot.png" }, undefined, undefined, blind.ctx),
      /cannot see images; use ask_image/,
    );
  }),
);

test(
  "ask_video sends the file as a Responses input_file with Pi's credentials and mapped effort",
  withAgentDir({ video: { enabled: true, model: "media/gemini", thinkingLevel: "low" }, maxFileMB: 1 }, async (dir) => {
    fs.writeFileSync(path.join(dir, "clip.mp4"), Buffer.from("fake-mp4"));
    fs.writeFileSync(path.join(dir, "clip.mkv"), Buffer.from("x"));
    fs.writeFileSync(path.join(dir, "big.mp4"), Buffer.alloc(2 * 1024 * 1024));
    const app = harness(() => ({}), VISION, dir);
    const tool = app.tools.get("ask_video")!;
    const originalFetch = globalThis.fetch;
    let request: { url: string; init: any } | undefined;
    globalThis.fetch = (async (url: string, init: any) => {
      request = { url, init };
      return new Response(
        JSON.stringify({ output: [{ content: [{ type: "output_text", text: "A red square moves right." }] }] }),
      );
    }) as typeof fetch;
    try {
      const result = await tool.execute(
        "1",
        { path: "clip.mp4", question: "What moves?" },
        undefined,
        undefined,
        app.ctx,
      );
      assert.equal(result.content[0].text, "A red square moves right.");
      assert.equal(request!.url, "http://proxy.test/v1/responses");
      assert.equal(request!.init.headers.authorization, "Bearer secret-key");
      assert.equal(request!.init.headers["x-extra"], "1");
      const body = JSON.parse(request!.init.body);
      assert.equal(body.model, "gemini");
      assert.deepEqual(body.reasoning, { effort: "minimal-ish" });
      assert.deepEqual(body.input[0].content[1], {
        type: "input_file",
        filename: "clip.mp4",
        file_data: `data:video/mp4;base64,${Buffer.from("fake-mp4").toString("base64")}`,
      });
      await assert.rejects(
        tool.execute("2", { path: "clip.mkv", question: "?" }, undefined, undefined, app.ctx),
        /Unsupported video format "\.mkv"/,
      );
      await assert.rejects(
        tool.execute("2b", { path: "missing.mp4", question: "?" }, undefined, undefined, app.ctx),
        /File not found/,
      );
      await assert.rejects(
        tool.execute("3", { path: "big.mp4", question: "?" }, undefined, undefined, app.ctx),
        /over the 1 MB limit/,
      );

      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ error: { message: "too large" } }), { status: 413 })) as typeof fetch;
      await assert.rejects(
        tool.execute("4", { path: "clip.mp4", question: "?" }, undefined, undefined, app.ctx),
        /HTTP 413: too large/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }),
);
