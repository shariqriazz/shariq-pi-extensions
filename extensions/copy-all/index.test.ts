import assert from "node:assert/strict";
import test from "node:test";
import { formatConversation, textFromMessageContent } from "./index.ts";

test("extracts only visible text and image markers", () => {
  assert.equal(
    textFromMessageContent([
      { type: "thinking", text: "private" },
      { type: "text", text: "Visible" },
      { type: "toolCall", name: "read" },
      { type: "image" },
    ]),
    "Visible\n[image]",
  );
});

test("formats the active conversation without tools or hidden reasoning", () => {
  assert.equal(
    formatConversation([
      { role: "system", content: "hidden" },
      { role: "user", content: "Question" },
      { role: "assistant", content: [{ type: "text", text: "Answer" }, { type: "thinking", text: "hidden" }] },
      { role: "toolResult", content: "secret output" },
    ]),
    "USER:\nQuestion\n\n---\n\nASSISTANT:\nAnswer",
  );
});
