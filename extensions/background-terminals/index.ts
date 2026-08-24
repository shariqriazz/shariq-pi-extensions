import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { settlementDelivery } from "../shared/settlement-delivery.ts";
import { oneLine, sanitizeTerminalText, stateLabel } from "../shared/tui-dashboard.ts";
import { TerminalManager, MAX_RUNNING_TERMINALS } from "./src/manager.ts";
import {
  formatCompletion,
  formatReadResult,
  formatTerminal,
} from "./src/presentation.ts";
import type { TerminalReadResult, TerminalSnapshot } from "./src/types.ts";
import { openTerminalDashboard } from "./src/ui.ts";

const STATUS_KEY = "background-terminals";

function titleFrom(command: string, title?: string): string {
  const requested = oneLine(title ?? "").slice(0, 100);
  if (requested) return requested;
  return oneLine(command).slice(0, 100) || "terminal";
}

function resolveCwd(base: string, requested?: string): string {
  const cwd = path.resolve(base, requested ?? ".");
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`working_dir is not a directory: ${cwd}`);
  }
  return cwd;
}

export default function backgroundTerminals(pi: ExtensionAPI) {
  const deliverSettlement = settlementDelivery(pi);
  let manager: TerminalManager | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let lastStatus = "";
  const pendingResults = new Map<string, TerminalSnapshot>();
  const modelOwned = new Set<string>();
  const starting = new Set<string>();

  const getManager = (): TerminalManager => {
    if (manager) return manager;
    manager = new TerminalManager();
    (globalThis as any).__pi_get_active_terminals = () => {
      if (!manager) return [];
      return manager.list().filter((s) => s.status === "running").map((s) => `${s.id}: "${oneLine(s.title)}" (pid ${s.pid})`);
    };
    manager.setOnSettled((snapshot) => {
      if (!modelOwned.delete(snapshot.id)) {
        ui?.notify(
          `${snapshot.id} "${oneLine(snapshot.title)}" ${snapshot.status} (exit ${snapshot.exitCode ?? "?"})`,
          snapshot.status === "failed" ? "error" : "info",
        );
        return;
      }
      pendingResults.set(snapshot.id, snapshot);
      if (!starting.has(snapshot.id)) flushResult(snapshot.id);
    });
    unsubscribe = manager.view.subscribe(updateStatus);
    updateStatus();
    return manager;
  };

  const consume = (id: string): void => {
    pendingResults.delete(id);
  };

  function updateStatus(): void {
    if (!ui || !manager) return;
    const terminals = manager.list();
    const running = terminals.filter((terminal) => terminal.status === "running").length;
    const next = running > 0
      ? `${running} background terminal${running === 1 ? "" : "s"} · /term`
      : "";
    if (next === lastStatus) return;
    lastStatus = next;
    if (!next) ui.setStatus(STATUS_KEY, undefined);
    else {
      ui.setStatus(
        STATUS_KEY,
        stateLabel(ui.theme, "active", next),
      );
    }
  }

  function flushResult(id: string): void {
    const snapshot = pendingResults.get(id);
    if (!snapshot) return;
    pendingResults.delete(id);
    deliverSettlement({
      customType: "background-terminal-result",
      content: formatCompletion(snapshot),
      display: true,
      details: {
        id: snapshot.id,
        title: snapshot.title,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
      },
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ui = ctx.ui;
  });

  pi.on("session_shutdown", async () => {
    pendingResults.clear();
    modelOwned.clear();
    starting.clear();
    unsubscribe?.();
    unsubscribe = undefined;
    ui?.setStatus(STATUS_KEY, undefined);
    ui = undefined;
    lastStatus = "";
    const closing = manager;
    manager = undefined;
    await closing?.dispose();
  });

  pi.registerTool({
    name: "start_terminal",
    label: "Start Background Terminal",
    description:
      "Start a command in a real background pseudo-terminal (PTY) and return its terminal id. " +
      "Use for development servers, watchers, long builds, and commands that need terminal semantics. " +
      "The PTY accepts later input through write_terminal, captures a bounded live tail in memory, writes a size-limited private temporary log, and is stopped at session shutdown. " +
      `At most ${MAX_RUNNING_TERMINALS} terminals may run concurrently.`,
    promptSnippet: "Start an interactive or long-running command in a managed background PTY.",
    promptGuidelines: [
      "Use start_terminal by default for servers, watchers, downloads, long or uncertain builds and tests, interactive shells, and any command that should not occupy the main turn; reserve bash for short commands whose result is needed immediately. Never use a large bash timeout merely to wait for long work.",
      "After start_terminal returns, continue only genuinely independent work. If none remains, end the turn immediately. Terminal settlement stays in a private extension queue while the parent is active and starts one custom-result turn at Pi's safe idle edge. When that result invokes the parent, continue the original task immediately without waiting for the user or rereading the same terminal; do not call read_terminal, list_terminals, or start a timer merely to check whether it finished.",
      "Use stop_terminal when a managed process is no longer needed. Background terminals are session-scoped and are stopped during session shutdown or reload.",
    ],
    parameters: Type.Object({
      command: Type.String({ minLength: 1, maxLength: 32_000, description: "Shell command to run in the PTY." }),
      title: Type.Optional(Type.String({ maxLength: 100, description: "Short human-readable terminal name; defaults to the command." })),
      working_dir: Type.Optional(Type.String({ description: "Working directory relative to the current workspace, or an absolute directory." })),
      wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5_000, description: "Optional initial wait for startup output; default 300ms." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const command = params.command.trim();
      if (!command) throw new Error("command must not be empty.");
      const terminal = getManager().start({
        command,
        title: titleFrom(command, params.title),
        cwd: resolveCwd(ctx.cwd, params.working_dir),
      });
      modelOwned.add(terminal.id);
      starting.add(terminal.id);
      let result: TerminalReadResult;
      try {
        result = await getManager().read(terminal.id, {
          cursor: 0,
          waitMs: params.wait_ms ?? 300,
          signal,
        });
      } catch (error) {
        starting.delete(terminal.id);
        modelOwned.delete(terminal.id);
        await getManager().kill([terminal.id]).catch(() => undefined);
        consume(terminal.id);
        throw error;
      }
      starting.delete(terminal.id);
      if (result.snapshot.status !== "running") consume(terminal.id);
      else flushResult(terminal.id);
      let text = `Started background terminal ${terminal.id} "${oneLine(terminal.title)}" (pid ${terminal.pid}). Use cursor ${result.cursor} for incremental reads.`;
      if (result.text || result.snapshot.status !== "running") {
        text += `\n\n${formatReadResult(result)}`;
      }
      return {
        content: [{ type: "text", text }],
        details: {
          id: terminal.id,
          pid: terminal.pid,
          status: result.snapshot.status,
          cursor: result.cursor,
          logPath: terminal.output.spillPath,
        },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("terminal"))} ${theme.fg("accent", oneLine(args.title ?? args.command))}\n${theme.fg("dim", `$ ${oneLine(args.command)}`)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Starting PTY…"), 0, 0);
      const details = result.details as { id?: string; pid?: number; status?: string } | undefined;
      return new Text(
        `${stateLabel(theme, details?.status === "running" ? "active" : "success", details?.status ?? "started")} ${theme.fg("muted", `${details?.id ?? "?"} · pid ${details?.pid ?? "?"} · /term to inspect`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "read_terminal",
    label: "Read Background Terminal",
    description:
      "Read output from a managed background terminal only when the user asks for progress or current output is required for immediate interaction. " +
      "Do not use it to wait for completion: terminal settlement automatically sends a follow-up that starts the next parent turn. " +
      "Pass the cursor from the previous terminal result to receive only newer output. Output is tail-truncated for model context; the private log path is reported when available.",
    promptSnippet: "Read new output from a managed background terminal by id and cursor.",
    parameters: Type.Object({
      id: Type.String({ description: 'Terminal id, for example "term-1".' }),
      cursor: Type.Optional(Type.Integer({ minimum: 0, description: "Cursor returned by the previous terminal operation; omit for the retained tail." })),
      wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000, description: "Long-poll duration when no newer output exists; default 0." })),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await getManager().read(params.id, {
        cursor: params.cursor,
        waitMs: params.wait_ms,
        signal,
      });
      return {
        content: [{ type: "text", text: formatReadResult(result) }],
        details: {
          id: params.id,
          status: result.snapshot.status,
          cursor: result.cursor,
          exitCode: result.snapshot.exitCode,
          omittedBytes: result.omittedBytes,
          logPath: result.snapshot.output.spillPath,
        },
      };
    },
  });

  pi.registerTool({
    name: "write_terminal",
    label: "Write Background Terminal",
    description:
      "Send input to a running background PTY, optionally press Enter, wait briefly, and return output produced since the supplied cursor. " +
      "Use input \\u0003 with press_enter=false to send Ctrl+C inside the PTY; use stop_terminal to terminate the managed process tree.",
    promptSnippet: "Send input to a running background PTY and collect its response.",
    parameters: Type.Object({
      id: Type.String({ description: "Terminal id." }),
      input: Type.String({ maxLength: 65_536, description: "Text or control character to write." }),
      press_enter: Type.Optional(Type.Boolean({ description: "Append Enter after the input; default true." })),
      cursor: Type.Optional(Type.Integer({ minimum: 0, description: "Previous output cursor for incremental output." })),
      wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 5_000, description: "Wait for resulting output; default 250ms." })),
    }),
    async execute(_toolCallId, params, signal) {
      const current = getManager().get(params.id);
      if (!current) throw new Error(`Unknown background terminal "${params.id}".`);
      const cursor = params.cursor ?? current.output.cursor;
      const input = params.press_enter === false ? params.input : `${params.input}\r`;
      getManager().write(params.id, input);
      const result = await getManager().read(params.id, {
        cursor,
        waitMs: params.wait_ms ?? 250,
        signal,
      });
      return {
        content: [{ type: "text", text: formatReadResult(result) }],
        details: {
          id: params.id,
          status: result.snapshot.status,
          cursor: result.cursor,
          exitCode: result.snapshot.exitCode,
        },
      };
    },
  });

  pi.registerTool({
    name: "list_terminals",
    label: "List Background Terminals",
    description: "List managed background terminals with status, pid, elapsed time, output size, and working directory.",
    parameters: Type.Object({}),
    async execute() {
      const terminals = getManager().list();
      return {
        content: [{ type: "text", text: terminals.length ? terminals.map(formatTerminal).join("\n") : "No background terminals." }],
        details: { terminals: terminals.map((terminal) => ({ id: terminal.id, title: terminal.title, status: terminal.status, pid: terminal.pid })) },
      };
    },
  });

  pi.registerTool({
    name: "stop_terminal",
    label: "Stop Background Terminals",
    description: "Stop one or more managed background terminal process groups, escalating from SIGTERM to SIGKILL when needed, and return their final states.",
    promptSnippet: "Stop managed background terminals and their process trees.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), { minItems: 1, maxItems: 32, description: "Terminal ids to stop." }),
    }),
    async execute(_toolCallId, params) {
      const terminals = await getManager().kill(params.ids);
      for (const terminal of terminals) consume(terminal.id);
      return {
        content: [{ type: "text", text: terminals.map((terminal) => `${terminal.id} "${oneLine(terminal.title)}" is ${terminal.status} (exit ${terminal.exitCode ?? "?"}).`).join("\n") }],
        details: { terminals: terminals.map((terminal) => ({ id: terminal.id, status: terminal.status, exitCode: terminal.exitCode })) },
      };
    },
  });

  pi.registerMessageRenderer(
    "background-terminal-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as { id?: string; title?: string; status?: string; exitCode?: number };
      const state = details.status === "done" ? "success" : details.status === "killed" ? "muted" : "error";
      const header = `${stateLabel(theme, state, details.status ?? "settled")} ${theme.fg("accent", theme.bold(`${details.id ?? "?"} · ${oneLine(details.title ?? "terminal")}`))}${theme.fg("muted", ` · exit ${details.exitCode ?? "?"}`)}`;
      const body = sanitizeTerminalText(typeof message.content === "string" ? message.content : "").split("\n").slice(1).join("\n").trim();
      if (expanded) {
        const markdown = new Markdown(body, 0, 0, getMarkdownTheme());
        const title = new Text(header, 0, 0);
        return {
          render: (width: number) => [...title.render(width), ...markdown.render(width)],
          invalidate: () => { title.invalidate(); markdown.invalidate(); },
        };
      }
      const preview = body.split("\n").slice(0, 8);
      return new Text(
        [header, ...preview.map((line) => theme.fg("toolOutput", line)), ...(body.split("\n").length > 8 ? [theme.fg("dim", "… ctrl+o to expand")] : [])].join("\n"),
        0,
        0,
      );
    },
  );

  const openCommand = async (ctx: ExtensionCommandContext) => {
    const terminals = getManager().list();
    if (ctx.mode !== "tui") {
      if (ctx.hasUI) ctx.ui.notify(terminals.length ? terminals.map(formatTerminal).join("\n") : "No background terminals.", "info");
      return;
    }
    if (terminals.length === 0) {
      ctx.ui.notify("No background terminals yet. The agent starts them with start_terminal.", "info");
      return;
    }
    await openTerminalDashboard(ctx, getManager().view);
  };

  pi.registerCommand("term", {
    description: "Start, stop, list, or inspect background terminals",
    getArgumentCompletions: (prefix) => {
      const values = ["start", "stop", "list"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.startsWith("start ")) {
        const command = trimmed.slice("start ".length).trim();
        if (!command) {
          ctx.ui.notify("Usage: /term start <command>", "error");
          return;
        }
        try {
          const terminal = getManager().start({
            command,
            title: titleFrom(command),
            cwd: ctx.cwd,
          });
          ctx.ui.notify(`Started ${terminal.id} "${terminal.title}" · use /term to inspect`, "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (trimmed.startsWith("stop ")) {
        const ids = [...new Set(trimmed.slice("stop ".length).split(/[\\s,]+/).filter(Boolean))];
        if (ids.length === 0) {
          ctx.ui.notify("Usage: /term stop <id> [id…]", "error");
          return;
        }
        try {
          const stopped = await getManager().kill(ids);
          for (const terminal of stopped) consume(terminal.id);
          ctx.ui.notify(stopped.map((terminal) => `${terminal.id}: ${terminal.status}`).join(" · "), "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (trimmed && trimmed !== "list") {
        ctx.ui.notify("Use /term, /term list, /term start <command>, or /term stop <id>.", "error");
        return;
      }
      await openCommand(ctx);
    },
  });
  pi.registerCommand("ps", {
    description: "Open the background terminal control center",
    handler: async (_args, ctx) => openCommand(ctx),
  });

  pi.on("session_shutdown", () => {
    delete (globalThis as any).__pi_get_active_terminals;
  });
}
