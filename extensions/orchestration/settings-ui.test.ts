import assert from "node:assert/strict";
import test from "node:test";
import { openOrchestrationSettings } from "./settings-ui.ts";

test("cancelling unchanged orchestration settings does not report a save", async () => {
  const notices: string[] = [];
  const changed = await openOrchestrationSettings({
    ui: {
      async select() { return undefined; },
      notify(message: string) { notices.push(message); },
    },
    modelRegistry: { getAll() { return []; } },
  } as never);
  assert.equal(changed, false);
  assert.deepEqual(notices, []);
});
