import assert from "node:assert/strict";
import test from "node:test";
import { OutputBuffer } from "./src/output-buffer.ts";

test("retains a bounded UTF-8 tail and reports omitted cursor bytes", () => {
  const buffer = new OutputBuffer(12);
  buffer.push("first-");
  const cursor = buffer.totalBytes;
  buffer.push("ééé-tail");

  const incremental = buffer.readSince(cursor);
  assert.equal(incremental.text, "ééé-tail");
  assert.equal(incremental.omittedBytes, 0);
  assert.equal(incremental.cursor, buffer.totalBytes);

  const whole = buffer.readSince(0);
  assert.ok(Buffer.byteLength(whole.text, "utf8") <= 12);
  assert.ok(whole.omittedBytes > 0);
  assert.equal(whole.text.includes("�"), false);
  assert.equal(buffer.view().truncatedBytes, whole.omittedBytes);
});

test("spills every chunk before in-memory eviction", () => {
  let spilled = "";
  const buffer = new OutputBuffer(5, (chunk) => { spilled += chunk; });
  buffer.push("abc");
  buffer.push("def");
  assert.equal(spilled, "abcdef");
  assert.equal(buffer.view().text, "def");
});
