import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { openModelPicker } from "../shared/model-picker.ts";
import {
  defaultConfig,
  MEMORY_REASONING_LEVELS,
  saveMemoryModelConfig,
  type MemoryModelConfig,
  type MemoryReasoningLevel,
} from "./src/config.ts";
import { formatMemoryContext, selectForInjection } from "./src/retrieval.ts";
import { MemoryService } from "./src/service.ts";
import { MEMORY_KINDS, type MemoryKind, type MemoryRecord, type MemoryScope } from "./src/types.ts";

function toolText(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function formatSearchResults(results: MemoryRecord[]): string {
  if (results.length === 0) return "No matching memories.";
  return results.map((memory) =>
    `${memory.memoryId}  ${memory.scope}/${memory.kind}  ${memory.title}\n${memory.content}`,
  ).join("\n\n");
}

const MEMORY_TOOL_NAMES = new Set([
  "pi_memory_search",
  "pi_memory_read",
  "pi_memory_save",
  "pi_memory_correct",
  "pi_memory_forget",
  "pi_memory_status",
]);

export default function piMemory(pi: ExtensionAPI) {
  const config = defaultConfig();
  const service = new MemoryService(config);

  const active = (ctx: ExtensionContext): boolean => config.enabledModes.has(ctx.mode);
  const projectFor = (ctx: Pick<ExtensionContext, "cwd">) => service.project(ctx.cwd);

  pi.registerTool({
    name: "pi_memory_search",
    label: "Search Pi Memory",
    description: "Search durable global and current-project memories. Returns at most the requested number of concise records.",
    promptSnippet: "Search durable Pi memories for deeper historical context",
    promptGuidelines: ["Use pi_memory_search when auto-injected memory is insufficient and past Pi work could materially help."],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "What to find" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const project = projectFor(ctx);
      const results = service.search(params.query, project.id, params.limit ?? 10);
      service.database.recordAccess(results.map((memory) => memory.memoryId));
      return toolText(formatSearchResults(results), { count: results.length, memoryIds: results.map((memory) => memory.memoryId) });
    },
  });

  pi.registerTool({
    name: "pi_memory_read",
    label: "Read Pi Memory",
    description: "Read one durable memory by exact ID, including scope, provenance, confidence, and timestamps.",
    parameters: Type.Object({ memoryId: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const memory = service.database.getMemory(params.memoryId);
      if (!memory || memory.status !== "active") throw new Error(`Active memory not found: ${params.memoryId}`);
      service.database.recordAccess([memory.memoryId]);
      const sources = service.database.listSources(memory.memoryId);
      return toolText(JSON.stringify({ ...memory, sources }, null, 2), { memoryId: memory.memoryId, sourceCount: sources.length });
    },
  });

  pi.registerTool({
    name: "pi_memory_save",
    label: "Save Pi Memory",
    description: "Save one explicit durable memory. Use global only for stable cross-project preferences; otherwise use project.",
    parameters: Type.Object({
      scope: StringEnum(["global", "project"] as const),
      kind: StringEnum(MEMORY_KINDS),
      title: Type.String({ minLength: 1, maxLength: 160 }),
      content: Type.String({ minLength: 1, maxLength: 4000 }),
      tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 16 })),
      importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const memory = service.save({
        scope: params.scope,
        project: projectFor(ctx),
        kind: params.kind,
        title: params.title,
        content: params.content,
        ...(params.tags ? { tags: params.tags } : {}),
        ...(params.importance ? { importance: params.importance } : {}),
      });
      return toolText(`Saved ${memory.scope} memory ${memory.memoryId}: ${memory.title}`, { memoryId: memory.memoryId });
    },
  });

  pi.registerTool({
    name: "pi_memory_correct",
    label: "Correct Pi Memory",
    description: "Correct an existing durable memory by exact memory ID. Use only when the user corrects stored information.",
    parameters: Type.Object({
      memoryId: Type.String({ minLength: 1 }),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      content: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { maxItems: 16 })),
      importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const memory = service.correct(params.memoryId, {
        project: projectFor(ctx),
        ...(params.title ? { title: params.title } : {}),
        ...(params.content ? { content: params.content } : {}),
        ...(params.tags ? { tags: params.tags } : {}),
        ...(params.importance ? { importance: params.importance } : {}),
      });
      if (!memory) throw new Error(`Active memory not found: ${params.memoryId}`);
      return toolText(`Corrected memory ${memory.memoryId}: ${memory.title}`, { memoryId: memory.memoryId });
    },
  });

  pi.registerTool({
    name: "pi_memory_forget",
    label: "Forget Pi Memory",
    description: "Soft-delete one durable memory by exact ID. Use only on an explicit user request to forget it.",
    parameters: Type.Object({ memoryId: Type.String({ minLength: 1 }) }),
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      if (!service.forget(params.memoryId)) throw new Error(`Active memory not found: ${params.memoryId}`);
      return toolText(`Forgot memory ${params.memoryId}.`, { memoryId: params.memoryId });
    },
  });

  pi.registerTool({
    name: "pi_memory_status",
    label: "Pi Memory Status",
    description: "Show Pi Memory counts, queue state, and storage paths.",
    parameters: Type.Object({}),
    async execute() {
      const status = service.status();
      return toolText(JSON.stringify(status, null, 2), status);
    },
  });

  pi.registerCommand("memory-status", {
    description: "Show Pi Memory status",
    handler: async (_args, ctx) => ctx.ui.notify(JSON.stringify(service.status()), "info"),
  });

  pi.registerCommand("memory-model", {
    description: "Select the provider, model, and reasoning level used only for Pi Memory extraction",
    handler: async (args, ctx) => {
      const available = ctx.modelRegistry.getAvailable();
      let selected: MemoryModelConfig | undefined;
      const direct = args.trim().match(/^(\S+)\/(\S+)\s+(off|minimal|low|medium|high|xhigh|max)$/);

      if (direct) {
        const [, provider, model, reasoning] = direct;
        const match = available.find((candidate) => candidate.provider === provider && candidate.id === model);
        if (!match) {
          ctx.ui.notify(`Unavailable memory model: ${provider}/${model}`, "error");
          return;
        }
        if (!match.reasoning && reasoning !== "off") {
          ctx.ui.notify(`${provider}/${model} does not support reasoning; select off.`, "error");
          return;
        }
        selected = { provider: provider!, model: model!, reasoning: reasoning as MemoryReasoningLevel };
      } else if (args.trim()) {
        ctx.ui.notify("Usage: /memory-model [provider/model reasoning]", "warning");
        return;
      } else {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /memory-model <provider/model> <reasoning>", "warning");
          return;
        }
        const current = config.extractionModel;
        const picked = await openModelPicker(ctx, {
          title: "Pi Memory Extraction Model",
          currentModel: `${current.provider}/${current.model}`,
        });
        if (!picked) return;

        const [provider, ...rest] = picked.split("/");
        const modelId = rest.join("/");
        const model = available.find((candidate) => candidate.provider === provider && candidate.id === modelId);
        if (!model) {
          ctx.ui.notify(`Model ${picked} is not available.`, "error");
          return;
        }

        const levels = model.reasoning ? [...MEMORY_REASONING_LEVELS] : ["off" as const];
        levels.sort((a, b) => Number(b === current.reasoning) - Number(a === current.reasoning));
        const reasoning = levels.length > 1 ? await ctx.ui.select("Pi Memory extraction reasoning", levels) : "off";
        if (!reasoning) return;
        selected = { provider: provider!, model: modelId, reasoning: reasoning as MemoryReasoningLevel };
      }

      config.extractionModel = selected;
      saveMemoryModelConfig(config.root, selected);
      ctx.ui.notify(`Pi Memory extraction: ${selected.provider}/${selected.model} (${selected.reasoning})`, "info");
    },
  });

  pi.registerCommand("memory-search", {
    description: "Search Pi Memory: /memory-search <query>",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) { ctx.ui.notify("Usage: /memory-search <query>", "warning"); return; }
      const results = service.search(query, projectFor(ctx).id, 10);
      service.database.recordAccess(results.map((memory) => memory.memoryId));
      ctx.ui.notify(formatSearchResults(results).slice(0, 8_000), "info");
    },
  });

  pi.registerCommand("memory-review", {
    description: "Review high-priority global and current-project memories",
    handler: async (args, ctx) => {
      const project = projectFor(ctx);
      const query = args.trim();
      const memories = query ? service.search(query, project.id, 30) : service.review(project.id, 30);
      ctx.ui.notify(formatSearchResults(memories).slice(0, 12_000), "info");
    },
  });

  pi.registerCommand("memory-save", {
    description: "Save a memory: /memory-save [global|project] <text>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(?:(global|project)\s+)?([\s\S]+)$/);
      if (!match) { ctx.ui.notify("Usage: /memory-save [global|project] <text>", "warning"); return; }
      const scope = (match[1] ?? "project") as MemoryScope;
      const content = match[2]!.trim();
      const memory = service.save({
        scope,
        project: projectFor(ctx),
        kind: "reference",
        title: content.split(/[.!?\n]/, 1)[0]!.slice(0, 140),
        content,
      });
      ctx.ui.notify(`Saved ${scope} memory ${memory.memoryId}`, "info");
    },
  });

  pi.registerCommand("memory-correct", {
    description: "Correct memory content: /memory-correct <id> <replacement text>",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!match) { ctx.ui.notify("Usage: /memory-correct <id> <replacement text>", "warning"); return; }
      const memory = service.correct(match[1]!, { project: projectFor(ctx), content: match[2]!.trim() });
      ctx.ui.notify(memory ? `Corrected ${memory.memoryId}` : `Active memory not found: ${match[1]}`, memory ? "info" : "warning");
    },
  });

  pi.registerCommand("memory-forget", {
    description: "Forget a memory by exact ID: /memory-forget <id>",
    handler: async (args, ctx) => {
      const memoryId = args.trim();
      if (!memoryId) { ctx.ui.notify("Usage: /memory-forget <id>", "warning"); return; }
      const forgotten = service.forget(memoryId);
      ctx.ui.notify(forgotten ? `Forgot ${memoryId}` : `Active memory not found: ${memoryId}`, forgotten ? "info" : "warning");
    },
  });

  pi.registerCommand("memory-rebuild", {
    description: "Rebuild the Pi Memory search index and Markdown projections",
    handler: async (_args, ctx) => {
      service.rebuild();
      ctx.ui.notify("Pi Memory search index and projections rebuilt.", "info");
    },
  });

  pi.registerCommand("memory-process", {
    description: "Capture this session and process pending memory jobs",
    handler: async (_args, ctx) => {
      if (!active(ctx)) { ctx.ui.notify("Memory capture is disabled in this Pi mode.", "warning"); return; }
      service.enqueueCurrentSession(ctx, projectFor(ctx));
      await service.processPending(ctx, 10);
      ctx.ui.notify(`Memory processing finished. ${service.status().memories} active memories.`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!active(ctx)) {
      pi.setActiveTools(pi.getActiveTools().filter((name) => !MEMORY_TOOL_NAMES.has(name)));
      return;
    }
    service.initialize(ctx.cwd);
    ctx.ui.setStatus("pi-memory", undefined);
    void service.processPending(ctx, 1);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!active(ctx)) return;
    const project = projectFor(ctx);
    const memories = selectForInjection(service.database, event.prompt, project.id, {
      maxResults: config.maxInjectedMemories,
      maxCharacters: config.maxInjectedCharacters,
    });
    if (memories.length === 0) return;
    service.database.recordAccess(memories.map((memory) => memory.memoryId));
    return { systemPrompt: `${event.systemPrompt}\n\n${formatMemoryContext(memories)}` };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active(ctx)) return;
    service.enqueueCurrentSession(ctx, projectFor(ctx));
    void service.processPending(ctx, 1);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (!active(ctx)) return;
    service.enqueueCurrentSession(ctx, projectFor(ctx));
    void service.processPending(ctx, 1);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (active(ctx)) service.enqueueCurrentSession(ctx, projectFor(ctx));
    if (ctx.hasUI) ctx.ui.setStatus("pi-memory", undefined);
    await service.shutdown();
  });
}
