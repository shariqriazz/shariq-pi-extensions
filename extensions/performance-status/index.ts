import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface GenerationMetrics {
  requestStartedAt?: number;
  firstTokenAt?: number;
  completedAt?: number;
  streamedChars: number;
  exactOutputTokens?: number;
  /** Running tool calls by id; parallel calls end independently. */
  runningTools: Map<string, string>;
  phase: "idle" | "waiting" | "generating" | "tool" | "done";
}

const STATUS_ID = "generation-performance";
const RENDER_INTERVAL_MS = 100;
const DONE_LINGER_MS = 8_000;

function duration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

function tokenCount(tokens: number, estimated = false) {
  const value = tokens < 1_000 ? `${Math.max(0, Math.round(tokens))}` : `${(tokens / 1_000).toFixed(1)}k`;
  return `${estimated ? "~" : ""}${value}`;
}

function values(metrics: GenerationMetrics, now = Date.now()) {
  const elapsed = metrics.requestStartedAt
    ? Math.max(0, (Math.min(metrics.completedAt ?? now, now) - metrics.requestStartedAt) / 1_000)
    : undefined;
  const ttft =
    metrics.requestStartedAt && metrics.firstTokenAt
      ? Math.max(0, (metrics.firstTokenAt - metrics.requestStartedAt) / 1_000)
      : undefined;
  const estimatedTokens = metrics.streamedChars / 4;
  const outputTokens = metrics.exactOutputTokens ?? estimatedTokens;
  // TPS is reported output tokens per second after the first streamed delta.
  // TTFT runs from the provider HTTP call to that delta, so it covers provider
  // latency, prefill, and any reasoning the provider does not stream.
  const generationSeconds = metrics.firstTokenAt
    ? Math.max(0, ((metrics.completedAt ?? now) - metrics.firstTokenAt) / 1_000)
    : undefined;
  const tps = generationSeconds && generationSeconds > 0.05 ? outputTokens / generationSeconds : undefined;
  return {
    elapsed,
    ttft,
    outputTokens,
    estimated: metrics.exactOutputTokens === undefined,
    tps,
  };
}

function toolLabel(running: Map<string, string>) {
  const [first] = running.values();
  if (!first) return "tool running";
  return running.size > 1 ? `tool ${first} +${running.size - 1}` : `tool ${first}`;
}

export function formatPerformanceStatus(metrics: GenerationMetrics, ctx: ExtensionContext, now = Date.now()) {
  const theme = ctx.ui.theme;
  const measured = values(metrics, now);
  const label =
    metrics.phase === "waiting"
      ? "waiting"
      : metrics.phase === "generating"
        ? "generating"
        : metrics.phase === "tool"
          ? toolLabel(metrics.runningTools)
          : "last response";
  const parts = [
    `${theme.fg("accent", "◆")} ${theme.fg(metrics.phase === "done" ? "muted" : "accent", label)}`,
    measured.tps === undefined
      ? undefined
      : theme.fg("text", `TPS ${measured.estimated ? "~" : ""}${Math.round(measured.tps)} tok/s`),
    measured.ttft === undefined ? undefined : theme.fg("muted", `TTFT ${duration(measured.ttft)}`),
    measured.elapsed === undefined ? undefined : theme.fg("muted", duration(measured.elapsed)),
    measured.outputTokens > 0
      ? theme.fg("muted", `${tokenCount(measured.outputTokens, measured.estimated)} out`)
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(theme.fg("dim", " · "));
}

export default function performanceStatus(pi: ExtensionAPI) {
  const metrics: GenerationMetrics = { streamedChars: 0, runningTools: new Map(), phase: "idle" };
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let doneTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRenderAt = 0;

  const cancelDoneTimer = () => {
    if (!doneTimer) return;
    clearTimeout(doneTimer);
    doneTimer = undefined;
  };

  const scheduleDoneHide = (ctx: ExtensionContext) => {
    cancelDoneTimer();
    doneTimer = setTimeout(() => {
      doneTimer = undefined;
      if (metrics.phase === "done" && ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
    }, DONE_LINGER_MS);
    doneTimer.unref?.();
  };

  const render = (ctx: ExtensionContext, immediate = false) => {
    if (!ctx.hasUI || metrics.phase === "idle") return;
    const now = Date.now();
    const remaining = RENDER_INTERVAL_MS - (now - lastRenderAt);
    if (!immediate && remaining > 0) {
      if (!renderTimer) {
        renderTimer = setTimeout(() => {
          renderTimer = undefined;
          lastRenderAt = Date.now();
          ctx.ui.setStatus(STATUS_ID, formatPerformanceStatus(metrics, ctx));
        }, remaining);
        renderTimer.unref?.();
      }
      return;
    }
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = undefined;
    lastRenderAt = now;
    ctx.ui.setStatus(STATUS_ID, formatPerformanceStatus(metrics, ctx, now));
  };

  pi.on("turn_start", (_event, ctx) => {
    cancelDoneTimer();
    metrics.requestStartedAt = Date.now();
    metrics.firstTokenAt = undefined;
    metrics.completedAt = undefined;
    metrics.streamedChars = 0;
    metrics.exactOutputTokens = undefined;
    metrics.runningTools.clear();
    metrics.phase = "waiting";
    render(ctx, true);
  });

  // turn_start precedes local request preparation (context hooks, auth); the
  // provider headers hook fires just before the HTTP call, including retries.
  pi.on("before_provider_headers", () => {
    if (metrics.phase !== "waiting") return;
    metrics.requestStartedAt = Date.now();
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const update = event.assistantMessageEvent;
    if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta") {
      metrics.firstTokenAt ??= Date.now();
      metrics.streamedChars += update.delta.length;
      metrics.phase = "generating";
      render(ctx);
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    metrics.completedAt ??= Date.now();
    metrics.exactOutputTokens = event.message.usage.output;
    metrics.phase = "done";
    render(ctx, true);
    scheduleDoneHide(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    cancelDoneTimer();
    metrics.runningTools.set(event.toolCallId, event.toolName);
    metrics.phase = "tool";
    render(ctx, true);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    metrics.runningTools.delete(event.toolCallId);
    if (metrics.runningTools.size > 0) {
      render(ctx, true);
      return;
    }
    metrics.phase = metrics.completedAt !== undefined ? "done" : "generating";
    render(ctx, true);
    if (metrics.phase === "done") scheduleDoneHide(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = undefined;
    cancelDoneTimer();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
  });
}
