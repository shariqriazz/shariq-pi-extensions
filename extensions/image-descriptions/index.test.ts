import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import imageDescriptions, { DEFAULT_CONFIG, loadConfig } from "./index.ts";

const PNG = { type: "image" as const, data: Buffer.from("fake-png").toString("base64"), mimeType: "image/png" };

function withAgentDir(config: unknown, run: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-image-descriptions-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    if (config !== undefined) fs.writeFileSync(path.join(dir, "image-descriptions.json"), JSON.stringify(config));
    try {
      await run(dir);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function harness(reply: (prompt: string) => { text?: string; error?: string }) {
  const hooks = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const prompts: string[] = [];
  const notices: string[] = [];
  imageDescriptions({
    on(name: string, handler: (...args: any[]) => any) {
      hooks.set(name, handler);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  } as never);
  const model = { provider: "vision", id: "flash", input: ["text", "image"], reasoning: true, maxTokens: 8_000 };
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
    cwd: process.cwd(),
    modelRegistry: {
      find: (provider: string, id: string) => (provider === "vision" && id === "flash" ? model : undefined),
      streamSimple(_model: unknown, context: any, options: any) {
        prompts.push(`${options.reasoning}|${context.messages[0].content[0].text}`);
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
  return { hooks, tools, prompts, notices, ctx };
}

test(
  "stays off and registers nothing unless enabled with a model",
  withAgentDir(undefined, () => {
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
    const app = harness(() => ({ text: "unused" }));
    assert.equal(app.hooks.size, 0);
    assert.equal(app.tools.size, 0);
  }),
);

test(
  "replaces tool-result images with a stored description and keeps failures as images",
  withAgentDir({ enabled: true, model: "vision/flash", thinkingLevel: "low" }, async (dir) => {
    let fail = false;
    const app = harness(() => (fail ? { error: "quota" } : { text: "A login form with the error: Invalid password." }));
    assert.deepEqual([...app.tools.keys()].sort(), ["ask_image", "view_image"]);
    await app.hooks.get("input")!({ text: "check the login page", source: "interactive" }, app.ctx);

    const event = {
      toolName: "read",
      toolCallId: "1",
      input: { path: "shot.png" },
      content: [{ type: "text", text: "Read image file" }, PNG],
    };
    const result = await app.hooks.get("tool_result")!(event, app.ctx);
    assert.equal(result.content.length, 2);
    assert.equal(result.content[1].type, "text");
    assert.match(result.content[1].text, /Invalid password/);
    const saved = /saved at (\S+)\. Use/.exec(result.content[1].text)![1]!;
    assert.ok(saved.startsWith(dir) && fs.existsSync(saved), "the original is kept for later questions");
    assert.match(app.prompts[0]!, /^low\|.*read tool.*check the login page/s);

    // Nested script calls and the extension's own view_image keep their images.
    assert.equal(await app.hooks.get("tool_result")!({ ...event, parentToolCallId: "0" }, app.ctx), undefined);
    assert.equal(await app.hooks.get("tool_result")!({ ...event, toolName: "view_image" }, app.ctx), undefined);

    fail = true;
    assert.equal(await app.hooks.get("tool_result")!(event, app.ctx), undefined);
    assert.match(app.notices.at(-1)!, /Image left as is: quota/);
  }),
);

test(
  "describes attached images into the user's text",
  withAgentDir({ enabled: true, model: "vision/flash" }, async () => {
    const app = harness(() => ({ text: "A bar chart of monthly revenue." }));
    const result = await app.hooks.get("input")!(
      { text: "what does this show?", images: [PNG], source: "interactive" },
      app.ctx,
    );
    assert.equal(result.action, "transform");
    assert.deepEqual(result.images, []);
    assert.match(result.text, /^what does this show\?\n\n\[Image described by flash; saved at .*\]\nA bar chart/s);
    assert.deepEqual(await app.hooks.get("input")!({ text: "x", images: [PNG], source: "extension" }, app.ctx), {
      action: "continue",
    });
  }),
);
