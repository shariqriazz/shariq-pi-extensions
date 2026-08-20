import assert from "node:assert/strict";
import test from "node:test";
import shellShortcutsExtension from "./index.ts";

test("registers /exit as a graceful shutdown alias", async () => {
  let command: { name: string; definition: any } | undefined;
  shellShortcutsExtension({
    registerCommand(name: string, definition: any) {
      command = { name, definition };
    },
  } as never);

  assert.equal(command?.name, "exit");
  assert.equal(command?.definition.description, "Alias for /quit");

  let shutdowns = 0;
  await command?.definition.handler("", { shutdown: () => { shutdowns++; } });
  assert.equal(shutdowns, 1);
});
