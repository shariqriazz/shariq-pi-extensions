import assert from "node:assert/strict";
import test from "node:test";
import { hasSensitiveToolArguments, redactSecrets, sanitizeToolArguments } from "../src/redaction.ts";
import { captureSession, isMemoryEligibleTool } from "../src/session.ts";
import type { ProjectIdentity } from "../src/types.ts";

const project: ProjectIdentity = {
  id: "p", identity: "path:/project", rootPath: "/project", displayName: "project", directoryName: "project-p",
};

test("redacts common credentials and omits sensitive file arguments", () => {
  assert.equal(redactSecrets("api_key=super-secret-value"), "api_key=<redacted>");
  const authorization = redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
  assert.ok(authorization.includes("<redacted>"));
  assert.ok(!authorization.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.equal(sanitizeToolArguments("read", { path: "/tmp/.env" }), "[sensitive path omitted]");
  assert.ok(!redactSecrets("AWS_SECRET_ACCESS_KEY = abcdefghijklmnopqrstuvwxyz").includes("abcdefghijklmnopqrstuvwxyz"));
  assert.equal(redactSecrets("https://user:password123@example.com/path"), "https://user:<redacted>@example.com/path");
  assert.equal(redactSecrets("DATABASE_URL=postgres://alice:hunter2@db.example/app"), "DATABASE_URL=<redacted>");
  assert.equal(redactSecrets("databaseUrl=postgres://alice:hunter2@db.example/app"), "databaseUrl=<redacted>");
  assert.equal(hasSensitiveToolArguments("read", { path: "/tmp/.env.production" }), true);
});

test("hard-denies web, browser, and observation tools from memory ingestion", () => {
  assert.equal(isMemoryEligibleTool("read"), true);
  assert.equal(isMemoryEligibleTool("spawn_agent"), true);
  assert.equal(isMemoryEligibleTool("web_fetch"), false);
  assert.equal(isMemoryEligibleTool("agentic_browser_screenshot"), false);
  assert.equal(isMemoryEligibleTool("chronicle_observe"), false);
});

test("captures only the active Pi branch and does not serialize thinking", () => {
  const entries = [
    { type: "message", id: "u1", message: { role: "user", content: "Remember project convention; api_key=abcdef-secret-value" } },
    { type: "message", id: "a1", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private chain" },
      { type: "text", text: "I will apply it." },
      { type: "toolCall", id: "call-sensitive", name: "read", arguments: { path: "/tmp/.env" } },
    ] } },
    { type: "message", id: "t1", message: { role: "toolResult", toolCallId: "call-sensitive", toolName: "read", isError: false, content: [{ type: "text", text: "DATABASE_URL=postgres://alice:hunter2@db.example/app" }] } },
    { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "toolCall", name: "web_fetch", arguments: { url: "https://example.com" } }] } },
    { type: "message", id: "t2", message: { role: "toolResult", toolName: "web_fetch", isError: false, content: [{ type: "text", text: "external page content must not enter memory" }] } },
  ];
  const sessionManager = {
    getBranch: () => entries,
    getSessionId: () => "session",
    getSessionFile: () => "/session.jsonl",
  };
  const captured = captureSession({ sessionManager } as never, project, undefined, 20_000);
  assert.ok(captured);
  assert.ok(captured.transcript.includes("Remember project convention"));
  assert.ok(!captured.transcript.includes("private chain"));
  assert.ok(!captured.transcript.includes("abcdef-secret-value"));
  assert.ok(!captured.transcript.includes("hunter2"));
  assert.ok(!captured.transcript.includes("external page content"));
  assert.ok(!captured.transcript.includes("example.com"));
  assert.ok(captured.transcript.includes("<redacted>"));
  assert.deepEqual(captured.entryIds, ["u1", "a1"]);
  assert.ok(!captured.queryText.includes("abcdef-secret-value"));
  assert.equal(captureSession({ sessionManager } as never, project, "t1", 20_000), undefined);
});
