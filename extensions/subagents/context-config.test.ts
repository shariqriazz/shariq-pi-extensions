import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaskPrompt, forkConversation, parseForkTurns } from "./src/context.ts";
import { loadConfigDocument, loadSubagentConfig, resolveProfile, saveConfigDocument, type SubagentConfig } from "./src/config.ts";
import { SUBAGENT_SPAWN_PROMPT_GUIDELINES, WORKTREE_ISOLATION_DESCRIPTION } from "./src/prompt.ts";
import { allocateSubagentId } from "./src/catalog.ts";
import { capabilityGuardExtension, childToolAllowed, filterToolsForCapability } from "./src/backends/pi.ts";
import { childArgs, piCommand } from "./src/backends/pi-process.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 });
const assistant = (text: string) => ({
  role: "assistant" as const,
  content: [
    { type: "thinking" as const, thinking: "private" },
    { type: "text" as const, text },
    { type: "toolCall" as const, id: "call", name: "read", arguments: {} },
  ],
  api: "test" as const,
  provider: "test",
  model: "test",
  usage,
  stopReason: "toolUse" as const,
  timestamp: 2,
});

test("persistent ids preserve the legacy sa-N shape without collisions", () => {
  const first = allocateSubagentId();
  const second = allocateSubagentId();
  assert.match(first, /^sa-\d+$/);
  assert.notEqual(first, second);
});

test("subagent guidance defaults to shared workspace and reserves isolation for real interference", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join(" ");
  assert.match(guidance, /Keep isolation none unless concurrent writers would overlap/);
  assert.match(WORKTREE_ISOLATION_DESCRIPTION, /^Default none/);
  assert.match(WORKTREE_ISOLATION_DESCRIPTION, /clean source checkout/);
});

test("profile instructions and the assigned task have explicit prompt boundaries", () => {
  assert.equal(
    buildTaskPrompt("Inspect auth.", "Do not edit.", "careful"),
    '<subagent_instructions>\nProfile instructions with persona "careful":\nDo not edit.\n</subagent_instructions>\n\nTask:\nInspect auth.',
  );
});

test("fork_turns accepts none, all, and positive counts", () => {
  assert.equal(parseForkTurns(undefined), "none");
  assert.equal(parseForkTurns("all"), "all");
  assert.equal(parseForkTurns("2"), 2);
  assert.throws(() => parseForkTurns("0"), /fork_turns/);
});

test("context forks keep selected conversation but remove tool protocol and thinking", () => {
  const messages = [user("one"), assistant("answer one"), user("two"), assistant("answer two")];
  const forked = forkConversation(messages, 1);
  assert.deepEqual(forked.map((message) => message.role), ["user", "assistant"]);
  assert.ok(forked[0]?.role === "user");
  assert.deepEqual(forked[0].content, [{ type: "text", text: "two" }]);
  const final = forked[1];
  assert.ok(final?.role === "assistant");
  assert.deepEqual(final.content, [{ type: "text", text: "answer two" }]);
  assert.equal(final.stopReason, "stop");
});

test("configuration editor validates and saves trusted project documents", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-config-test-"));
  try {
    const text = JSON.stringify({ maxConcurrent: 7, profiles: { reviewer: { capability: "execute" } }, personas: {} });
    saveConfigDocument("project", cwd, text);
    assert.equal(JSON.parse(loadConfigDocument("project", cwd)).maxConcurrent, 7);
    assert.throws(
      () => saveConfigDocument("project", cwd, '{"maxConcurrent":99}'),
      /1 to 50/,
    );
    assert.throws(
      () => saveConfigDocument("project", cwd, '{"profiles":{"bad":{"capability":"root"}}}'),
      /capability must be one of/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("partial profile overrides keep the built-in capability and instructions", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-config-test-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agent-dir-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    saveConfigDocument("global", cwd, JSON.stringify({ profiles: { explore: { model: "global/model" } } }));
    saveConfigDocument("project", cwd, JSON.stringify({ profiles: { explore: { description: "Project explorer" } } }));
    const explore = loadSubagentConfig(cwd, true).profiles.explore;
    assert.equal(explore?.capability, "execute");
    assert.equal(explore?.model, "global/model");
    assert.equal(explore?.description, "Project explorer");
    assert.match(explore?.instructions ?? "", /Do not modify files/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("restrictive capabilities fail closed for extension execution tools", () => {
  const inventory = [
    "read",
    "write",
    "edit",
    "bash",
    "web_fetch",
    "task_list",
    "start_terminal",
    "write_terminal",
    "unclassified_extension_tool",
    "unknown_project_tool",
    "message_parent",
  ];
  assert.deepEqual(
    filterToolsForCapability(inventory, "read-only"),
    ["read", "web_fetch", "task_list", "message_parent"],
  );
  assert.deepEqual(
    filterToolsForCapability(inventory, "read-write"),
    ["read", "write", "edit", "web_fetch", "task_list", "message_parent"],
  );
  assert.deepEqual(
    filterToolsForCapability(inventory, "execute"),
    ["read", "bash", "web_fetch", "task_list", "start_terminal", "write_terminal", "message_parent"],
  );
  assert.deepEqual(filterToolsForCapability(inventory, "all"), inventory);
});

test("profile resolution applies explicit overrides before profile and persona defaults", () => {
  const config: SubagentConfig = {
    maxConcurrent: 4,
    fusion: false,
    tiers: {},
    profiles: { reviewer: { capability: "read-only", model: "profile-model", instructions: "Review." } },
    personas: { concise: { instructions: "Be concise.", model: "persona-model", isolation: "worktree" } },
  };
  assert.deepEqual(resolveProfile(config, {
    agentType: "reviewer",
    persona: "concise",
    model: "explicit-model",
    capability: "execute",
  }), {
    agentType: "reviewer",
    persona: "concise",
    instructions: "Review.\n\nBe concise.",
    capability: "execute",
    model: "explicit-model",
    thinking: undefined,
    isolation: "worktree",
    childOptions: { runtime: "in-process", tools: undefined, skills: true, contextFiles: true, extensions: true },
  });
});

function withAgentDir(run: (cwd: string) => void) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-config-test-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agent-dir-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    run(cwd);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test("fusion mode is off by default and adds tiered profiles when enabled", () => {
  withAgentDir((cwd) => {
    const off = loadSubagentConfig(cwd, true);
    assert.equal(off.fusion, false);
    assert.equal(off.profiles.sidekick, undefined);
    assert.equal(off.profiles.explore?.tier, undefined);

    saveConfigDocument("global", cwd, JSON.stringify({ fusion: true }));
    const on = loadSubagentConfig(cwd, true);
    assert.equal(on.fusion, true);
    assert.deepEqual(
      Object.fromEntries(["sidekick", "explore", "reviewer", "worker", "verifier", "general-purpose"].map((name) => [name, on.profiles[name]?.tier])),
      { sidekick: "medium", explore: "medium", reviewer: "medium", worker: "light", verifier: "light", "general-purpose": "heavy" },
    );
    assert.equal(on.profiles.verifier?.capability, "execute");
    assert.equal(on.profiles.explore?.capability, "execute");
    assert.match(on.profiles.explore?.instructions ?? "", /Do not modify files/);

    saveConfigDocument("project", cwd, JSON.stringify({ fusion: false }));
    assert.equal(loadSubagentConfig(cwd, true).profiles.sidekick, undefined);
    assert.equal(loadSubagentConfig(cwd, false).profiles.sidekick?.tier, "medium");

    // Resuming a Fusion child still works after the mode is off, without changing other profiles.
    const resumable = loadSubagentConfig(cwd, true, { resumable: true });
    assert.equal(resumable.fusion, false);
    assert.equal(resumable.profiles.sidekick?.tier, "medium");
    assert.equal(resumable.profiles.explore?.tier, undefined);
  });
});

test("tiers supply model and thinking below profile and call overrides", () => {
  withAgentDir((cwd) => {
    saveConfigDocument("global", cwd, JSON.stringify({
      fusion: true,
      tiers: { light: { model: "light/model", thinking: "low" }, medium: { model: "medium/model" } },
      profiles: { worker: { thinking: "minimal" }, custom: { tier: "light" } },
    }));
    const config = loadSubagentConfig(cwd, true);
    assert.deepEqual(config.tiers, { light: { model: "light/model", thinking: "low" }, medium: { model: "medium/model" } });
    const pick = (agentType: string, extra: { model?: string } = {}) => {
      const { model, thinking } = resolveProfile(config, { agentType, ...extra });
      return { model, thinking };
    };
    assert.deepEqual(pick("sidekick"), { model: "medium/model", thinking: undefined });
    assert.deepEqual(pick("worker"), { model: "light/model", thinking: "minimal" });
    assert.deepEqual(pick("custom", { model: "call/model" }), { model: "call/model", thinking: "low" });
    assert.deepEqual(pick("general-purpose"), { model: undefined, thinking: undefined });
    // User fields merge over the Fusion defaults instead of replacing them.
    assert.match(config.profiles.worker?.instructions ?? "", /bounded edit/);
    for (const light of ["worker", "verifier"]) {
      assert.match(config.profiles[light]?.instructions ?? "", /parallel tool calls in one turn/);
    }
  });
});

test("fusion and tier settings are validated when saved", () => {
  withAgentDir((cwd) => {
    assert.throws(() => saveConfigDocument("global", cwd, JSON.stringify({ fusion: "yes" })), /fusion must be true or false/);
    assert.throws(() => saveConfigDocument("global", cwd, JSON.stringify({ tiers: { huge: {} } })), /Unknown tier "huge"/);
    assert.throws(() => saveConfigDocument("global", cwd, JSON.stringify({ tiers: { light: { thinking: "lots" } } })), /tiers.light.thinking/);
    assert.throws(() => saveConfigDocument("global", cwd, JSON.stringify({ profiles: { a: { tier: "huge" } } })), /tier must be one of/);
  });
});

test("restrictive children block unclassified tools at call time, including late registrations", () => {
  const handlers = new Map<string, (event: any) => any>();
  capabilityGuardExtension("read-only")({ on: (name: string, handler: any) => handlers.set(name, handler) } as never);
  const guard = handlers.get("tool_call")!;
  assert.equal(guard({ toolName: "read" }), undefined);
  assert.deepEqual(guard({ toolName: "late_extension_tool" }), {
    block: true,
    reason: 'Tool "late_extension_tool" is not permitted for this subagent.',
  });
  assert.equal(guard({ toolName: "bash" }).block, true);
  // codemode is allowed; the tools a script calls are checked one by one.
  assert.equal(guard({ toolName: "codemode" }), undefined);

  const unrestricted = new Map<string, unknown>();
  capabilityGuardExtension("all")({ on: (name: string, handler: unknown) => unrestricted.set(name, handler) } as never);
  assert.equal(unrestricted.size, 0);
});

test("profiles carry runtime, tool allowlist, and resource switches without touching personas", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-config-test-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agent-dir-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    saveConfigDocument("global", cwd, JSON.stringify({
      profiles: { reviewer: { capability: "execute", runtime: "process", tools: ["read", "bash"], skills: false, contextFiles: false } },
    }));
    assert.throws(() => saveConfigDocument("global", cwd, '{"profiles":{"bad":{"runtime":"vm"}}}'), /runtime must be one of/);
    assert.throws(() => saveConfigDocument("global", cwd, '{"profiles":{"bad":{"tools":[]}}}'), /non-empty array/);
    const profile = resolveProfile(loadSubagentConfig(cwd, false), { agentType: "reviewer" });
    assert.deepEqual(profile.childOptions, { runtime: "process", tools: ["read", "bash"], skills: false, contextFiles: false, extensions: true });
    assert.deepEqual(resolveProfile(loadSubagentConfig(cwd, false), {}).childOptions, { runtime: "in-process", tools: undefined, skills: true, contextFiles: true, extensions: true });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("an exact tool allowlist narrows the capability at call time", () => {
  assert.equal(childToolAllowed("read", "execute", ["read", "bash"]), true);
  assert.equal(childToolAllowed("bash", "execute", ["read", "bash"]), true);
  assert.equal(childToolAllowed("grep", "execute", ["read", "bash"]), false, "not in the allowlist");
  assert.equal(childToolAllowed("bash", "read-only", ["read", "bash"]), false, "the capability still applies");
  const handlers = new Map<string, (event: any) => any>();
  capabilityGuardExtension("all", ["read"])({ on: (name: string, handler: any) => handlers.set(name, handler) } as never);
  assert.equal(handlers.get("tool_call")!({ toolName: "write" }).block, true);
});

test("process children start the same Pi build with the profile's switches and the bridge", () => {
  const task = {
    capability: "read-only",
    reasoningEffort: "low",
    childOptions: { runtime: "process", skills: false, contextFiles: false, extensions: false },
    parent: { projectTrusted: false },
  } as never;
  const args = childArgs(task, { provider: "prov", id: "model-1" } as never, "/tmp/child.jsonl");
  assert.deepEqual(args.slice(0, 11), ["--mode", "rpc", "--session", "/tmp/child.jsonl", "--provider", "prov", "--model", "model-1", "--thinking", "low", "--no-approve"]);
  assert.ok(args.includes("--no-skills") && args.includes("--no-context-files") && args.includes("--no-extensions"));
  assert.match(args.at(-1)!, /child-bridge\.ts$/);
  assert.ok(!args.includes("--tools"), "the bridge filters tools so defaultTools such as codemode still apply");
});

test("process children run the same Pi entry script, following a pi symlink", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-cli-"));
  try {
    const cli = join(dir, "cli.js");
    writeFileSync(cli, "#!/usr/bin/env node\n");
    symlinkSync(cli, join(dir, "pi"));
    assert.deepEqual(piCommand(["/usr/bin/node", join(dir, "pi")], process.execPath), { file: process.execPath, args: [realpathSync(cli)] });
    assert.deepEqual(piCommand([process.execPath], process.execPath), { file: process.execPath, args: [] }, "a compiled binary runs itself");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
