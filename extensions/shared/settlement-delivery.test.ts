import assert from "node:assert/strict";
import test from "node:test";
import { deliverSettlement } from "./settlement-delivery.ts";

test("settlements are handed to Pi as turn-triggering follow-ups immediately", () => {
  const sent: Array<{ message: unknown; options: unknown }> = [];
  deliverSettlement({
    sendMessage(message: unknown, options: unknown) {
      sent.push({ message, options });
    },
  } as never, {
    customType: "fixture-result",
    content: "finished",
    display: true,
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]?.options, { deliverAs: "followUp", triggerTurn: true });
});
