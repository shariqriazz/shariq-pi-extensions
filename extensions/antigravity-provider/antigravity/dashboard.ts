import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { frameBottom, frameTop, joinSides, meter, oneLine, padLine, stateLabel } from "../../shared/tui-dashboard.ts";
import type { AntigravityAccountStatus, AntigravityQuotaEntry } from "./accounts.ts";

export interface AntigravityDashboardSnapshot {
  authentication: string;
  modelCount: number;
  accounts: AntigravityAccountStatus[];
  warning?: string;
}

type Theme = ExtensionContext["ui"]["theme"];

function remaining(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function until(timestamp: number | string | undefined) {
  const value = typeof timestamp === "number" ? timestamp : timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(value) || value <= Date.now()) return "now";
  const seconds = Math.max(0, Math.round((value - Date.now()) / 1_000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function groupQuota(quota: AntigravityQuotaEntry[] | undefined, group: "gemini" | "non-gemini") {
  const byWindow = new Map<"five-hour" | "weekly", AntigravityQuotaEntry>();
  for (const entry of (quota ?? []).filter((candidate) => candidate.group === group)) {
    const window = entry.window ?? "five-hour";
    const existing = byWindow.get(window);
    if (!existing || entry.remainingFraction < existing.remainingFraction) {
      byWindow.set(window, {
        ...entry,
        window,
        displayName: window === "weekly" ? "Weekly" : "5-Hour",
      });
    }
  }
  return (["five-hour", "weekly"] as const).flatMap((window) => {
    const entry = byWindow.get(window);
    return entry ? [entry] : [];
  });
}

function accountState(account: AntigravityAccountStatus) {
  if (account.disabled) return "disabled";
  if (account.cooldownUntil && account.cooldownUntil > Date.now()) return account.cooldownReason === "auth" ? "auth cooldown" : "cooldown";
  const quota = account.quota ?? [];
  if (quota.length && quota.every((entry) => entry.remainingFraction <= 0 && (!entry.resetTime || Date.parse(entry.resetTime) > Date.now()))) return "exhausted";
  if (account.quotaError && !quota.length) return "refresh error";
  return quota.length ? "ready" : "not refreshed";
}

function stateColor(state: string) {
  if (state === "ready") return "success" as const;
  if (state === "not refreshed" || state === "disabled") return "muted" as const;
  if (state === "refresh error" || state === "auth cooldown") return "error" as const;
  return "warning" as const;
}

function compactGroup(label: string, entries: AntigravityQuotaEntry[]) {
  if (!entries.length) return `${label}: unavailable`;
  return `${label}: ${entries.map((entry) => `${entry.displayName} ${remaining(entry.remainingFraction)}${entry.resetTime ? ` · resets ${until(entry.resetTime)}` : ""}`).join(" · ")}`;
}

export class AntigravityDashboard implements Component {
  private selected = 0;
  private refreshing = false;
  private closed = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private snapshot: AntigravityDashboardSnapshot;
  private readonly refreshData: (force: boolean) => Promise<AntigravityDashboardSnapshot>;
  private readonly toggleAccount: (id: string, enabled: boolean) => Promise<AntigravityDashboardSnapshot>;
  private readonly removeAccount: (id: string, label: string) => Promise<AntigravityDashboardSnapshot>;
  private readonly done: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    snapshot: AntigravityDashboardSnapshot,
    refreshData: (force: boolean) => Promise<AntigravityDashboardSnapshot>,
    toggleAccount: (id: string, enabled: boolean) => Promise<AntigravityDashboardSnapshot>,
    removeAccount: (id: string, label: string) => Promise<AntigravityDashboardSnapshot>,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.snapshot = snapshot;
    this.refreshData = refreshData;
    this.toggleAccount = toggleAccount;
    this.removeAccount = removeAccount;
    this.done = done;
  }

  startRefresh(force: boolean) {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    this.tui.requestRender();
    void this.refreshData(force)
      .then((snapshot) => this.replaceSnapshot(snapshot))
      .catch((error) => {
        if (!this.closed) this.snapshot = { ...this.snapshot, warning: `Refresh failed: ${error instanceof Error ? error.message : String(error)}` };
      })
      .finally(() => {
        if (!this.closed) {
          this.refreshing = false;
          this.tui.requestRender();
        }
      });
  }

  private replaceSnapshot(snapshot: AntigravityDashboardSnapshot) {
    if (this.closed) return;
    const id = this.snapshot.accounts[this.selected]?.id;
    this.snapshot = snapshot;
    const index = id ? snapshot.accounts.findIndex((account) => account.id === id) : -1;
    this.selected = index >= 0 ? index : Math.min(this.selected, Math.max(0, snapshot.accounts.length - 1));
  }

  dispose() { this.closed = true; }
  invalidate() {}

  handleInput(data: string) {
    const accounts = this.snapshot.accounts;
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.closed = true;
      this.done();
      return;
    }
    if (this.keys.matches(data, "tui.select.up") || data === "k") {
      if (accounts.length) this.selected = (this.selected - 1 + accounts.length) % accounts.length;
    } else if (this.keys.matches(data, "tui.select.down") || data === "j") {
      if (accounts.length) this.selected = (this.selected + 1) % accounts.length;
    } else if (data === "r") {
      this.startRefresh(true);
    } else if ((data === "d" || data === "x") && accounts[this.selected] && !this.refreshing) {
      const account = accounts[this.selected]!;
      this.refreshing = true;
      const action = data === "x"
        ? this.removeAccount(account.id, account.email || `account-${account.id.slice(0, 6)}`)
        : this.toggleAccount(account.id, account.disabled === true);
      void action
        .then((snapshot) => this.replaceSnapshot(snapshot))
        .catch((error) => {
          if (!this.closed) this.snapshot = { ...this.snapshot, warning: error instanceof Error ? error.message : String(error) };
        })
        .finally(() => {
          if (!this.closed) {
            this.refreshing = false;
            this.tui.requestRender();
          }
        });
    }
    this.tui.requestRender();
  }

  render(width: number) {
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(8, rows - 7);
    const accounts = this.snapshot.accounts;
    this.selected = Math.min(this.selected, Math.max(0, accounts.length - 1));
    const selected = accounts[this.selected];
    const active = accounts.filter((account) => account.active).length;
    const right = this.refreshing
      ? this.theme.fg("warning", "refreshing…")
      : this.snapshot.warning
        ? this.theme.fg("warning", oneLine(this.snapshot.warning))
        : this.theme.fg("muted", `${active}/${accounts.length} active · ${this.snapshot.modelCount} models`);
    const title = `  ${this.theme.fg("accent", this.theme.bold("◆ ANTIGRAVITY"))} ${this.theme.fg("dim", `· ${this.snapshot.authentication}`)}`;
    const lines = width >= 64
      ? [joinSides(title, `${right}  `, width)]
      : [truncateToWidth(title, width, ""), truncateToWidth(`  ${right}`, width, "")];
    lines.push(frameTop(this.theme, width, `ACCOUNTS ${accounts.length} · 5-HOUR + WEEKLY LIMITS REMAINING`));
    const inner = Math.max(1, width - 2);
    if (width >= 104 && selected) {
      const leftWidth = Math.max(46, Math.floor((inner - 1) * 0.45));
      const rightWidth = Math.max(24, inner - leftWidth - 1);
      const list = this.renderAccounts(leftWidth, bodyHeight, true);
      const detail = this.renderDetail(selected, rightWidth, bodyHeight);
      for (let row = 0; row < bodyHeight; row++) {
        lines.push(this.theme.fg("border", "│") + padLine(list[row] ?? "", leftWidth) + this.theme.fg("borderMuted", "│") + padLine(detail[row] ?? "", rightWidth) + this.theme.fg("border", "│"));
      }
    } else {
      const list = this.renderAccounts(inner, bodyHeight, false);
      for (let row = 0; row < bodyHeight; row++) lines.push(this.theme.fg("border", "│") + padLine(list[row] ?? "", inner) + this.theme.fg("border", "│"));
    }
    lines.push(frameBottom(this.theme, width));
    lines.push(truncateToWidth(`${this.theme.fg("accent", "  ↑↓ / j k")} ${this.theme.fg("dim", "select")}  ${this.theme.fg("accent", "r")} ${this.theme.fg("dim", "refresh")}  ${this.theme.fg("accent", "d")} ${this.theme.fg("dim", "enable/disable")}  ${this.theme.fg("accent", "x")} ${this.theme.fg("dim", "remove")}  ${this.theme.fg("accent", "esc")} ${this.theme.fg("dim", "close")}`, width, ""));
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderAccounts(width: number, height: number, compact: boolean) {
    const accounts = this.snapshot.accounts;
    if (!accounts.length) return [this.theme.fg("muted", " No Antigravity accounts saved."), this.theme.fg("dim", " Run /login antigravity once per Google account.")];
    const rowsPerAccount = compact ? 1 : 4;
    const visibleCount = Math.max(1, Math.floor(height / rowsPerAccount));
    const start = Math.min(Math.max(0, this.selected - Math.floor(visibleCount / 2)), Math.max(0, accounts.length - visibleCount));
    const lines: string[] = [];
    for (const [offset, account] of accounts.slice(start, start + visibleCount).entries()) {
      const index = start + offset;
      const selected = index === this.selected;
      const state = accountState(account);
      const marker = selected ? this.theme.fg("accent", "◆") : " ";
      const title = this.theme.fg(selected ? "accent" : "text", oneLine(account.email || `account-${account.id.slice(0, 6)}`));
      const first = joinSides(` ${marker} ${title}`, `${stateLabel(this.theme, stateColor(state), state)} `, width);
      lines.push(selected ? this.theme.bg("selectedBg", padLine(first, width)) : first);
      if (!compact) {
        lines.push(`   ${this.theme.fg("muted", compactGroup("Gemini", groupQuota(account.quota, "gemini")))}`);
        lines.push(`   ${this.theme.fg("muted", compactGroup("Claude", groupQuota(account.quota, "non-gemini")))}`);
        lines.push("");
      }
    }
    return lines.slice(0, height);
  }

  private renderDetail(account: AntigravityAccountStatus, width: number, height: number) {
    const state = accountState(account);
    const lines = [
      ` ${stateLabel(this.theme, stateColor(state), state)} ${this.theme.fg("accent", this.theme.bold(oneLine(account.email || `account-${account.id.slice(0, 6)}`)))}`,
      ` ${this.theme.fg("dim", account.quotaUpdatedAt ? `quota updated ${until(account.quotaUpdatedAt + 15 * 60 * 1_000)} refresh window` : "quota has not been refreshed")}`,
    ];
    if (account.cooldownUntil && account.cooldownUntil > Date.now()) lines.push(` ${this.theme.fg("warning", `${account.cooldownReason || "rotation"} cooldown · ${until(account.cooldownUntil)}`)}`);
    if (account.quotaError) lines.push(` ${this.theme.fg("error", oneLine(account.quotaError))}`);
    if (account.lastError) lines.push(` ${this.theme.fg("warning", oneLine(account.lastError))}`);
    lines.push("", ...this.renderQuotaGroup("Gemini models", groupQuota(account.quota, "gemini"), width));
    lines.push("", ...this.renderQuotaGroup("Claude models", groupQuota(account.quota, "non-gemini"), width));
    if (account.lastUsedAt) lines.push("", ` ${this.theme.fg("muted", "LAST USED")} ${this.theme.fg("text", new Date(account.lastUsedAt).toLocaleString())}`);
    return lines.slice(0, height);
  }

  private renderQuotaGroup(name: string, entries: AntigravityQuotaEntry[], width: number) {
    const lines = [` ${this.theme.fg("accent", this.theme.bold(`${name.toUpperCase()} · REMAINING`))}`];
    if (!entries.length) return [...lines, ` ${this.theme.fg("muted", "Unavailable")}`];
    const meterWidth = Math.max(10, width - 29);
    for (const entry of entries) {
      const percent = entry.remainingFraction * 100;
      const color = percent <= 0 ? "error" : percent <= 15 ? "warning" : "active";
      const label = oneLine(entry.displayName || entry.modelId).slice(0, 16).padEnd(16);
      lines.push(` ${this.theme.fg("muted", label)} ${meter(this.theme, percent, 100, meterWidth, color)} ${this.theme.fg("text", remaining(entry.remainingFraction))}${entry.resetTime ? ` ${this.theme.fg("dim", until(entry.resetTime))}` : ""}`);
    }
    return lines;
  }
}

export async function openAntigravityDashboard(
  ctx: ExtensionContext,
  initial: AntigravityDashboardSnapshot,
  refresh: (force: boolean) => Promise<AntigravityDashboardSnapshot>,
  toggle: (id: string, enabled: boolean) => Promise<AntigravityDashboardSnapshot>,
  remove: (id: string, label: string) => Promise<AntigravityDashboardSnapshot>,
) {
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) => {
      const dashboard = new AntigravityDashboard(tui, theme, keys, initial, refresh, toggle, remove, () => done(undefined));
      queueMicrotask(() => dashboard.startRefresh(false));
      return dashboard;
    },
    { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } },
  );
}
