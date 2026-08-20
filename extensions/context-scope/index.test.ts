import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import piContextScope, { internals } from "./index.ts";

test("registers only the expected lifecycle handlers and command", () => {
  const events: string[] = [];
  const commands: Array<{ name: string; description?: string }> = [];
  const pi = {
    on(name: string) {
      events.push(name);
    },
    registerCommand(name: string, options: { description?: string }) {
      commands.push({ name, description: options.description });
    },
  };

  piContextScope(pi as never);

  assert.deepEqual(events, [
    "message_end",
    "session_compact",
    "session_start",
    "model_select",
    "session_shutdown",
  ]);
  assert.deepEqual(commands.map(({ name }) => name), ["contextscope"]);
});

test("keeps core parsing and estimate helpers available", () => {
  assert.equal(internals.stripAnsi("\u001b[31mred\u001b[0m"), "red");
  assert.equal(internals.cleanDenominator(2.6), 2.6);
  assert.equal(internals.cleanDenominator(-1), 4);
  assert.match(internals.contextWindowLabel(372_000), /372k/i);
});

test("is standalone and has no runtime pine-of-glass imports", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.\.\/_lib\//);
  assert.doesNotMatch(source, /node_modules\/pine-of-glass/);
});
