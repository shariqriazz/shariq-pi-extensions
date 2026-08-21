import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { frameBottom, frameTop, joinSides, meter, oneLine, padLine, stateLabel } from "../../shared/tui-dashboard.ts";
import { dollars, percentUsed, type CursorUsageSnapshot } from "./usage.ts";

type Theme = ExtensionContext["ui"]["theme"];

export interface CursorDashboardSnapshot {
  authentication: string;
  keyExpiresAt?: number;
  usage?: CursorUsageSnapshot;
  error?: string;
}

function date(value: number | undefined): string {
  if (!value) return "unavailable";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function pct(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(value)}%` : "unavailable";
}

export class CursorDashboard implements Component {
  private refreshing = false;
  private closed = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private snapshot: CursorDashboardSnapshot;
  private readonly refreshData: () => Promise<CursorDashboardSnapshot>;
  private readonly done: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    snapshot: CursorDashboardSnapshot,
    refreshData: () => Promise<CursorDashboardSnapshot>,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.snapshot = snapshot;
    this.refreshData = refreshData;
    this.done = done;
  }

  startRefresh() {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    this.tui.requestRender();
    void this.refreshData()
      .then((snapshot) => { if (!this.closed) this.snapshot = snapshot; })
      .catch((error) => {
        if (!this.closed) this.snapshot = { ...this.snapshot, error: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        if (!this.closed) {
          this.refreshing = false;
          this.tui.requestRender();
        }
      });
  }

  dispose() { this.closed = true; }
  invalidate() {}

  handleInput(data: string) {
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.closed = true;
      this.done();
    } else if (data === "r") {
      this.startRefresh();
    }
    this.tui.requestRender();
  }

  render(width: number) {
    const usage = this.snapshot.usage;
    const plan = usage?.plan;
    const monthly = usage?.usage;
    const used = percentUsed(usage ?? { enabled: false, canAdjustOnDemand: false, models: [], fetchedAt: 0 });
    const status = this.snapshot.error ? "refresh error" : usage ? "ready" : "loading";
    const statusColor = this.snapshot.error ? "error" : usage ? "success" : "warning";
    const title = `  ${this.theme.fg("accent", this.theme.bold("◆ CURSOR"))} ${this.theme.fg("dim", `· ${this.snapshot.authentication}`)}`;
    const right = this.refreshing
      ? this.theme.fg("warning", "refreshing…")
      : this.theme.fg("muted", `${plan?.planName ?? "plan unavailable"} · ${usage?.models.length ?? 0} Cursor-owned models`);
    const lines = width >= 64
      ? [joinSides(title, `${right}  `, width)]
      : [truncateToWidth(title, width, ""), truncateToWidth(`  ${right}`, width, "")];
    lines.push(frameTop(this.theme, width, "CURRENT MONTH · CURSOR ACCOUNT USAGE"));
    const inner = Math.max(1, width - 2);
    const body: string[] = [
      ` ${stateLabel(this.theme, statusColor, status)} ${this.theme.fg("text", usage?.email ?? "Cursor account")}`,
      ` ${this.theme.fg("dim", `API key ${usage?.apiKeyName ?? "configured"} · created ${date(usage?.apiKeyCreatedAt)} · expires ${usage ? (usage.apiKeyExpiresAt ? date(usage.apiKeyExpiresAt) : "does not expire") : date(this.snapshot.keyExpiresAt)}`)}`,
      "",
    ];
    if (this.snapshot.error) {
      body.push(` ${this.theme.fg("error", oneLine(this.snapshot.error))}`, "", ` ${this.theme.fg("muted", "Press r to retry. Your credentials are never shown here.")}`);
    } else if (!usage || !monthly) {
      body.push(` ${this.theme.fg("muted", "Loading Cursor account usage…")}`);
    } else {
      const meterWidth = Math.max(12, inner - 29);
      body.push(
        ` ${this.theme.fg("accent", this.theme.bold("MONTHLY TOTAL USAGE"))}`,
        ` ${meter(this.theme, Math.min(100, used ?? 0), 100, meterWidth, (used ?? 0) >= 100 ? "error" : (used ?? 0) >= 85 ? "warning" : "active")} ${this.theme.fg("text", pct(used))}`,
        ` ${this.theme.fg("muted", "Cycle")} ${this.theme.fg("text", `${date(usage.billingCycleStart)} → ${date(usage.billingCycleEnd ?? plan?.billingCycleEnd)}`)}`,
        ` ${this.theme.fg("muted", "Total usage")} ${this.theme.fg("text", dollars(monthly.totalSpend))}  ${this.theme.fg("muted", "Purchased")} ${this.theme.fg("text", dollars(monthly.includedSpend || plan?.includedAmountCents))}  ${this.theme.fg("muted", "Bonus")} ${this.theme.fg("text", dollars(monthly.bonusSpend))}`,
        "",
        ` ${this.theme.fg("accent", this.theme.bold("CURSOR POOLS"))}`,
        ` ${this.theme.fg("muted", "Auto / Composer")} ${meter(this.theme, Math.min(100, monthly.autoPercentUsed ?? 0), 100, meterWidth, (monthly.autoPercentUsed ?? 0) >= 85 ? "warning" : "active")} ${this.theme.fg("text", pct(monthly.autoPercentUsed))}`,
        ` ${this.theme.fg("muted", "Named / API     ")} ${meter(this.theme, Math.min(100, monthly.apiPercentUsed ?? 0), 100, meterWidth, (monthly.apiPercentUsed ?? 0) >= 85 ? "warning" : "active")} ${this.theme.fg("text", pct(monthly.apiPercentUsed))}`,
        "",
        ` ${this.theme.fg("accent", this.theme.bold("ON-DEMAND"))}`,
        ` ${this.theme.fg("muted", "Adjustable")} ${this.theme.fg("text", usage.canAdjustOnDemand ? "yes" : "no")}  ${this.theme.fg("muted", "Limit")} ${this.theme.fg("text", dollars(usage.spendLimit?.individualLimit ?? usage.currentOnDemandLimitCents))}  ${this.theme.fg("muted", "Recommended")} ${this.theme.fg("text", dollars(usage.recommendedOnDemandLimitCents))}`,
        ` ${this.theme.fg("muted", "Used")} ${this.theme.fg("text", dollars(usage.spendLimit?.individualUsed))}  ${this.theme.fg("muted", "Remaining")} ${this.theme.fg("text", dollars(usage.spendLimit?.individualRemaining))}  ${this.theme.fg("muted", "Limit type")} ${this.theme.fg("text", usage.spendLimit?.limitType ?? "unavailable")}`,
        "",
        ` ${this.theme.fg("dim", `Updated ${date(usage.fetchedAt)} · values come from Cursor's current-period usage API`)}`,
      );
    }
    const bodyHeight = Math.max(12, (this.tui.terminal.rows || 30) - 6);
    for (let row = 0; row < bodyHeight; row++) {
      lines.push(this.theme.fg("border", "│") + padLine(body[row] ?? "", inner) + this.theme.fg("border", "│"));
    }
    lines.push(frameBottom(this.theme, width));
    lines.push(truncateToWidth(`${this.theme.fg("accent", "  r")} ${this.theme.fg("dim", "refresh")}  ${this.theme.fg("accent", "esc")} ${this.theme.fg("dim", "close")}`, width, ""));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}

export async function openCursorDashboard(
  ctx: ExtensionContext,
  initial: CursorDashboardSnapshot,
  refresh: () => Promise<CursorDashboardSnapshot>,
) {
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) => {
      const dashboard = new CursorDashboard(tui, theme, keys, initial, refresh, () => done(undefined));
      queueMicrotask(() => dashboard.startRefresh());
      return dashboard;
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } },
  );
}
