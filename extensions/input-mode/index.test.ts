import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadInputMode, saveInputMode } from "./config.ts";
import { createInputModeExtension } from "./index.ts";

function temporaryConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-input-mode-"));
  return { directory, file: path.join(directory, "input-mode.json") };
}

function harness(file: string) {
  const commands = new Map<string, any>();
  const hooks = new Map<string, (...args: any[]) => any>();
  const sent: Array<{ content: any; options: any }> = [];
  const statuses: Array<string | undefined> = [];
  const notices: Array<{ message: string; level: string }> = [];
  const ui = {
    setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    notify(message: string, level: string) { notices.push({ message, level }); },
    async select() { return undefined; },
  };
  createInputModeExtension({ configFile: file })({
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (...args: any[]) => any) { hooks.set(name, handler); },
    sendUserMessage(content: any, options: any) { sent.push({ content, options }); },
  } as never);
  return { commands, hooks, sent, statuses, notices, ui };
}

test("configuration defaults safely and persists an atomic restrictive document", () => {
  const fixture = temporaryConfig();
  try {
    assert.equal(loadInputMode(fixture.file), "steer");
    fs.writeFileSync(fixture.file, "not json");
    assert.equal(loadInputMode(fixture.file), "steer");
    saveInputMode("interrupt", fixture.file);
    assert.equal(loadInputMode(fixture.file), "interrupt");
    assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("steer, interrupt, and follow-up modes preserve distinct input semantics", async () => {
  const fixture = temporaryConfig();
  try {
    const app = harness(fixture.file);
    const input = app.hooks.get("input")!;
    let aborts = 0;
    const context = { abort() { aborts += 1; } };
    const event = { type: "input", text: "new direction", source: "interactive", streamingBehavior: "steer" };

    assert.deepEqual(input(event, context), { action: "continue" });
    assert.equal(aborts, 0);
    assert.equal(app.sent.length, 0);

    const commandContext = { hasUI: true, ui: app.ui };
    await app.commands.get("input-mode").handler("interrupt", commandContext);
    assert.equal(loadInputMode(fixture.file), "interrupt");
    assert.deepEqual(input(event, context), { action: "continue" });
    assert.equal(aborts, 1);

    await app.commands.get("input-mode").handler("follow-up", commandContext);
    const image = { type: "image", data: "fixture", mimeType: "image/png" };
    assert.deepEqual(input({ ...event, images: [image] }, context), { action: "handled" });
    assert.deepEqual(app.sent, [{
      content: [{ type: "text", text: "new direction" }, image],
      options: { deliverAs: "followUp" },
    }]);

    assert.deepEqual(input({ ...event, source: "extension" }, context), { action: "continue" });
    assert.deepEqual(input({ ...event, streamingBehavior: "followUp" }, context), { action: "continue" });
    assert.deepEqual(input({ ...event, streamingBehavior: undefined }, context), { action: "continue" });
    assert.equal(app.sent.length, 1);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("command validates direct input and exposes non-default mode status", async () => {
  const fixture = temporaryConfig();
  try {
    const app = harness(fixture.file);
    app.hooks.get("session_start")?.({}, { hasUI: true, ui: app.ui });
    assert.equal(app.statuses.at(-1), undefined);

    const commandContext = { hasUI: true, ui: app.ui };
    await app.commands.get("input-mode").handler("invalid", commandContext);
    assert.equal(loadInputMode(fixture.file), "steer");
    assert.match(app.notices.at(-1)?.message ?? "", /Usage: \/input-mode/);

    await app.commands.get("input-mode").handler("interrupt", commandContext);
    assert.equal(app.statuses.at(-1), "input: interrupt");
    app.hooks.get("session_shutdown")?.();
    assert.equal(app.statuses.at(-1), undefined);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
