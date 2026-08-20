import assert from "node:assert/strict";
import test from "node:test";
import { formatCompletion, formatReadResult, MODEL_OUTPUT_MAX_BYTES } from "./src/presentation.ts";

function snapshot(text: string) {
  return {
    id: "term-1",
    title: "large output",
    command: "generate output",
    cwd: "/tmp",
    pid: 123,
    status: "running",
    createdAt: Date.now(),
    output: {
      text,
      totalBytes: Buffer.byteLength(text),
      truncatedBytes: 10,
      cursor: Buffer.byteLength(text),
      version: 1,
      spillPath: "/tmp/full.log",
    },
    cols: 120,
    rows: 30,
  } as const;
}

test("model-facing terminal output is bounded and points to the full log", () => {
  const terminal = snapshot(Array.from({ length: 5_000 }, (_, index) => `line-${index} ${"x".repeat(40)}`).join("\n"));
  const read = formatReadResult({ snapshot: terminal, text: terminal.output.text, cursor: terminal.output.cursor, omittedBytes: 10 });
  assert.ok(Buffer.byteLength(read, "utf8") < MODEL_OUTPUT_MAX_BYTES + 2_000);
  assert.match(read, /Full log: \/tmp\/full\.log/);
  assert.match(read, /omitted/);

  const completion = formatCompletion({ ...terminal, status: "failed", exitCode: 1, settledAt: Date.now() });
  assert.ok(Buffer.byteLength(completion, "utf8") < 16 * 1024);
  assert.match(completion, /failed with exit 1/);
});
