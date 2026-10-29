import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import extension, { deriveBtwTitle } from "./index.ts";
import { saveConfigDocument } from "./src/config.ts";
import { SUBAGENT_SPAWN_PROMPT_GUIDELINES } from "./src/prompt.ts";

test("derives compact Unicode-safe titles for by-the-way questions", () => {
  assert.equal(deriveBtwTitle("  Why is this failing?\nMore detail"), "Why is this failing?");
  const long = "🧪".repeat(80);
  assert.equal([...deriveBtwTitle(long)].length, 60);
  assert.match(deriveBtwTitle(long), /…$/);
});

test("registers one Pi-only canonical API and the takeover dashboard", () => {
  const tools = new Map<string, any>();
  const commands: string[] = [];
  const hooks: string[] = [];
  const fakePi = {
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    on(name: string) {
      hooks.push(name);
    },
    sendMessage() {},
    getThinkingLevel() {
      return "medium";
    },
  };

  extension(fakePi as never);

  assert.deepEqual(
    [...tools.keys()],
    [
      "spawn_agent",
      "wait_agent",
      "close_agent",
      "check_agent",
      "list_agent_profiles",
      "list_agents",
      "send_message",
      "apply_agent_changes",
      "reply_question",
      "task",
    ],
  );
  assert.deepEqual(commands, ["btw", "subagents"]);
  for (const tool of tools.values()) {
    assert.equal(tool.exposure, "model-only", `${tool.name} should stay declared to the model`);
    assert.equal(typeof tool.renderCall, "function", `${tool.name} should render a compact call card`);
    assert.equal(typeof tool.renderResult, "function", `${tool.name} should render a compact result card`);
  }
  assert.ok(hooks.includes("session_start"));
  assert.ok(hooks.includes("agent_start"));
  assert.ok(hooks.includes("agent_settled"));
  assert.ok(hooks.includes("session_shutdown"));

  const spawnSchema = JSON.stringify(tools.get("spawn_agent")?.parameters);
  assert.match(spawnSchema, /message/);
  assert.match(spawnSchema, /agent_type/);
  assert.match(spawnSchema, /capability/);
  assert.match(spawnSchema, /fork_turns/);
  assert.match(spawnSchema, /resume_from/);
  assert.match(spawnSchema, /worktree/);
  assert.match(spawnSchema, /Default none/);
  assert.match(spawnSchema, /concurrent writers would overlap/);
  assert.doesNotMatch(spawnSchema, /harness|claude|codex/);

  const taskTool = tools.get("task");
  assert.match(JSON.stringify(taskTool?.parameters), /Default none/);
  assert.match(taskTool?.description ?? "", /background/);
  assert.match(taskTool?.description ?? "", /return their ids/);
  assert.match(taskTool?.description ?? "", /arrives as a message that starts your next turn/);
  assert.equal(taskTool?.promptGuidelines, undefined);

  const waitTool = tools.get("wait_agent");
  assert.match(waitTool?.description ?? "", /without waiting/);

  const guidelines = tools.get("spawn_agent")?.promptGuidelines.join("\n") ?? "";
  assert.match(guidelines, /only when the user asks to delegate/);
  assert.match(guidelines, /end the turn/);
  assert.match(guidelines, /instead of polling wait_agent, check_agent, or list_agents/);
  for (const legacy of ["subagent_spawn", "subagent_wait", "subagent_cancel", "subagent_check", "subagent_list"]) {
    assert.equal(tools.has(legacy), false);
  }
});

test("fusion mode swaps the lead's delegation rule and shows the fusion skill only to the lead", () => {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const fakePi = {
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
    sendMessage() {},
    getThinkingLevel() {
      return "medium";
    },
  };
  extension(fakePi as never);
  const hook = handlers.get("before_agent_start")!;

  const cwd = mkdtempSync(join(tmpdir(), "pi-subagent-fusion-test-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agent-dir-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const fusionSkillDir = fileURLToPath(new URL("../../skills/fusion", import.meta.url));
  const run = (tools: string[]) => {
    const options = {
      selectedTools: tools,
      toolGuidelines: tools.includes("spawn_agent") ? { spawn_agent: [...SUBAGENT_SPAWN_PROMPT_GUIDELINES] } : {},
      skills: [
        { name: "fusion", baseDir: fusionSkillDir },
        { name: "other", baseDir: cwd },
      ],
    };
    hook({ systemPromptOptions: options }, { cwd, isProjectTrusted: () => false });
    return {
      guidelines: options.toolGuidelines.spawn_agent?.join("\n") ?? "",
      skills: options.skills.map((skill) => skill.name),
    };
  };
  try {
    const off = run(["read", "spawn_agent"]);
    assert.match(off.guidelines, /only when the user asks to delegate/);
    assert.deepEqual(off.skills, ["other"]);

    saveConfigDocument("global", cwd, JSON.stringify({ fusion: true }));
    const lead = run(["read", "spawn_agent"]);
    assert.match(lead.guidelines, /Fusion mode is on, so delegate without being asked/);
    assert.match(
      lead.guidelines,
      /results you report or act on; a feature that computes metrics is still a sidekick build/,
    );
    assert.match(lead.guidelines, /self-contained .*hand it to the sidekick/);
    assert.match(lead.guidelines, /wrong result looks plausible.*you draw and check the conclusions/);
    assert.doesNotMatch(lead.guidelines, /only when the user asks to delegate/);
    assert.match(lead.guidelines, /instead of polling wait_agent/);
    assert.deepEqual(lead.skills, ["fusion", "other"]);

    assert.deepEqual(run(["read", "bash"]).skills, ["other"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
