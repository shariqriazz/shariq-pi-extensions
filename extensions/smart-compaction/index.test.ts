import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Api } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  loadSmartCompactionConfig,
  saveSmartCompactionConfig,
  type SmartCompactionConfig,
} from "./config.ts";
import {
  resolveCompactionModel,
  runSmartCompaction,
} from "./engine.ts";
import {
  formatFileOperationsXml,
  serializeConversationForCompaction,
  SMART_COMPACTION_INITIAL_PROMPT,
  SMART_COMPACTION_UPDATE_PROMPT,
} from "./prompt.ts";
import { createSmartCompactionExtension } from "./index.ts";

function createTmpConfig(): { dir: string; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-compaction-test-"));
  const file = path.join(dir, "smart-compaction.json");
  return {
    dir,
    file,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe("smart-compaction config", () => {
  it("loads default config when file does not exist", () => {
    const { file, cleanup } = createTmpConfig();
    try {
      const config = loadSmartCompactionConfig(file);
      assert.equal(config.version, 1);
      assert.equal(config.enabled, true);
      assert.equal(config.model, "inherit");
      assert.equal(config.thinkingLevel, "inherit");
      assert.equal(config.maxSummaryTokens, undefined);
    } finally {
      cleanup();
    }
  });

  it("saves and reloads config correctly", () => {
    const { file, cleanup } = createTmpConfig();
    try {
      const saved: SmartCompactionConfig = {
        version: 1,
        enabled: false,
        model: "factory/gemini-3.7-flash",
        thinkingLevel: "high",
        maxSummaryTokens: 8192,
      };
      saveSmartCompactionConfig(saved, file);
      const loaded = loadSmartCompactionConfig(file);
      assert.deepEqual(loaded, saved);
    } finally {
      cleanup();
    }
  });
});

describe("smart-compaction prompt & serialization", () => {
  it("formats file operations into XML blocks cleanly", () => {
    const fileOps = {
      read: new Set(["src/index.ts", "README.md"]),
      written: new Set(["src/out.ts"]),
      edited: new Set(["src/index.ts"]),
    };
    const xml = formatFileOperationsXml(fileOps);
    assert.match(xml, /<read-files>\nREADME\.md\n<\/read-files>/);
    assert.match(xml, /<modified-files>\nsrc\/index\.ts\nsrc\/out\.ts\n<\/modified-files>/);
  });

  it("serializes conversation with tool calls and tool results", () => {
    const agentMessages: AgentMessage[] = [
      {
        role: "user",
        content: "Refactor the authentication logic",
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should inspect auth.ts first" },
          { type: "text", text: "Reading the auth file." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/auth.ts" } },
        ],
      } as any,
      {
        role: "toolResult",
        toolCallId: "call-1",
        content: [{ type: "text", text: "export const auth = true;" }],
      } as any,
      {
        role: "bashExecution",
        command: "npm test",
        output: "All tests passing",
      } as any,
    ];

    const serialized = serializeConversationForCompaction(agentMessages);
    assert.match(serialized, /\[User\]:\nRefactor the authentication logic/);
    assert.match(serialized, /\[Assistant Thinking\]:\nI should inspect auth\.ts first/);
    assert.match(serialized, /\[Assistant\]:\nReading the auth file\./);
    assert.match(serialized, /\[Assistant Tool Calls\]:\nread\(path="src\/auth\.ts"\)/);
    assert.match(serialized, /\[Tool Result\]:\nexport const auth = true;/);
    assert.match(serialized, /\[Command Executed\]:\n\$ npm test\nAll tests passing/);
  });
});

describe("smart-compaction engine model resolution", () => {
  const dummySessionModel: Model<Api> = {
    id: "session-model",
    name: "Session Model",
    provider: "session-provider",
    api: "openai-responses",
    maxTokens: 4096,
    reasoning: true,
  } as any;

  const dummyDedicatedModel: Model<Api> = {
    id: "fast-model",
    name: "Fast Model",
    provider: "fast-provider",
    api: "openai-responses",
    maxTokens: 8192,
    reasoning: true,
  } as any;

  const mockRegistry = {
    find(provider: string, id: string) {
      if (provider === "fast-provider" && id === "fast-model") return dummyDedicatedModel;
      return undefined;
    },
    getAvailable() {
      return [dummySessionModel, dummyDedicatedModel];
    },
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text", text: "Generated smart summary checkpoint" }],
        usage: { input: 100, output: 50, totalTokens: 150 },
      };
    },
  };

  it("resolves inherit to active session model", () => {
    const ctx = {
      model: dummySessionModel,
      modelRegistry: mockRegistry as any,
    };
    const res = resolveCompactionModel(ctx, "inherit");
    assert.equal(res.isInherited, true);
    assert.equal(res.model.id, "session-model");
  });

  it("resolves explicit provider/model from registry", () => {
    const ctx = {
      model: dummySessionModel,
      modelRegistry: mockRegistry as any,
    };
    const res = resolveCompactionModel(ctx, "fast-provider/fast-model");
    assert.equal(res.isInherited, false);
    assert.equal(res.model.id, "fast-model");
  });

  it("falls back to session model when custom model is not found", () => {
    const ctx = {
      model: dummySessionModel,
      modelRegistry: mockRegistry as any,
    };
    const res = resolveCompactionModel(ctx, "unknown-provider/unknown-model");
    assert.equal(res.isInherited, true);
    assert.equal(res.model.id, "session-model");
  });

  it("runs smart compaction and returns structured result", async () => {
    const ctx = {
      model: dummySessionModel,
      modelRegistry: mockRegistry as any,
    };
    const event: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry-123",
        messagesToSummarize: [{ role: "user", content: "Implement feature X", timestamp: Date.now() }],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 5000,
        fileOps: { read: new Set(["a.ts"]), written: new Set(["b.ts"]), edited: new Set() } as any,
        settings: { enabled: true, reserveTokens: 16000, keepRecentTokens: 20000 },
      },
      branchEntries: [],
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    };

    const result = await runSmartCompaction({
      event,
      ctx,
      config: { version: 1, enabled: true, model: "inherit" },
    });

    assert.ok(result.summary.includes("Generated smart summary checkpoint"));
    assert.ok(result.summary.includes("<read-files>\na.ts\n</read-files>"));
    assert.ok(result.summary.includes("<modified-files>\nb.ts\n</modified-files>"));
    assert.equal(result.firstKeptEntryId, "entry-123");
    assert.equal(result.tokensBefore, 5000);
  });
});

describe("smart-compaction extension lifecycle & commands", () => {
  it("registers session_before_compact, slash commands, and status", async () => {
    const { file, cleanup } = createTmpConfig();
    const eventHandlers = new Map<string, Function>();
    const commands = new Map<string, any>();

    const mockPi: ExtensionAPI = {
      on(event: string, handler: Function) {
        eventHandlers.set(event, handler);
      },
      registerCommand(name: string, cmd: any) {
        commands.set(name, cmd);
      },
    } as any;

    const extension = createSmartCompactionExtension({ configFile: file });
    extension(mockPi);

    assert.ok(eventHandlers.has("session_start"));
    assert.ok(eventHandlers.has("session_before_compact"));
    assert.ok(eventHandlers.has("session_compact"));
    assert.ok(commands.has("compaction-model"));
    assert.ok(commands.has("smart-compaction"));

    const notifications: string[] = [];
    const statuses = new Map<string, string | undefined>();

    const mockCtx: ExtensionCommandContext = {
      hasUI: true,
      model: { id: "session-model", provider: "session-provider" } as any,
      modelRegistry: {
        getAvailable() {
          return [
            { id: "session-model", provider: "session-provider" },
            { id: "gemini-flash", provider: "factory" },
          ];
        },
      } as any,
      ui: {
        notify(msg: string) {
          notifications.push(msg);
        },
        setStatus(key: string, val?: string) {
          statuses.set(key, val);
        },
        async select() {
          return "factory/gemini-flash";
        },
      } as any,
    } as any;

    // Test /compaction-model interactive select
    const compactionModelCmd = commands.get("compaction-model");
    await compactionModelCmd.handler("", mockCtx);
    assert.equal(loadSmartCompactionConfig(file).model, "factory/gemini-flash");

    // Test /smart-compaction disable
    const smartCompactionCmd = commands.get("smart-compaction");
    await smartCompactionCmd.handler("disable", mockCtx);
    assert.equal(loadSmartCompactionConfig(file).enabled, false);

    // Test /smart-compaction enable
    await smartCompactionCmd.handler("enable", mockCtx);
    assert.equal(loadSmartCompactionConfig(file).enabled, true);

    cleanup();
  });
});
