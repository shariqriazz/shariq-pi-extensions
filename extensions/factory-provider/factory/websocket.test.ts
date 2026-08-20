import assert from "node:assert/strict";
import test from "node:test";
import {
  factoryResponsesWebSocketUrl,
  prepareFactoryResponsesWebSocketPayload,
} from "./websocket.ts";

test("Factory Responses API uses Droid's WebSocket endpoint", () => {
  assert.equal(
    factoryResponsesWebSocketUrl("https://api.factory.ai/api/llm/o/v1/responses"),
    "wss://api.factory.ai/api/llm/o/v1/responses/ws",
  );
});

test("Factory Responses WebSocket payload promotes the Droid marker to instructions", () => {
  const payload = prepareFactoryResponsesWebSocketPayload({
    model: "gpt-5.6-luna",
    input: [
      {
        role: "system",
        content: "You are Droid, an AI software engineering agent built by Factory.\n\nBe concise.",
      },
      { role: "user", content: [{ type: "input_text", text: "Reply only OK" }] },
    ],
    stream: true,
  });

  assert.equal(payload.type, "response.create");
  assert.equal(
    payload.instructions,
    "You are Droid, an AI software engineering agent built by Factory.\n\nBe concise.",
  );
  assert.deepEqual(payload.input, [
    { role: "user", content: [{ type: "input_text", text: "Reply only OK" }] },
  ]);
  assert.equal(payload.parallel_tool_calls, true);
  assert.equal(payload.tool_choice, "auto");
});
