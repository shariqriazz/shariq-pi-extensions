import assert from "node:assert/strict";
import test from "node:test";
import { deliverSettlement } from "./settlement-delivery.ts";

test("settlements are handed to Pi as model-visible user follow-ups immediately", async () => {
  const sent: Array<{ content: unknown; options: unknown }> = [];
  await deliverSettlement({
    sendUserMessage(content: unknown, options: unknown) {
      sent.push({ content, options });
      return Promise.resolve();
    },
  } as never, {
    customType: "fixture-result",
    content: "finished",
    display: true,
  });

  assert.deepEqual(sent, [{ content: "finished", options: { deliverAs: "followUp" } }]);
});
