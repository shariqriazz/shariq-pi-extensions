import type {
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  frameBottom,
  frameTop,
  joinSides,
  meter,
  oneLine,
  padLine,
  stateLabel,
} from "../../shared/tui-dashboard.ts";
import {
  exhaustedBucket,
  type FactoryLimitRecord,
  type FactoryPoolLimits,
} from "./limits.ts";

export interface FactoryDashboardAccount {
  id: string;
  label: string;
  record?: FactoryLimitRecord;
  cooldownSeconds?: number;
  lastUsedAt?: string;
}

export interface FactoryDashboardSnapshot {
  version: string;
  modelCount: number;
  authentication: string;
  configured: number;
  active: number;
  warning?: string;
  accounts: FactoryDashboardAccount[];
}

type Theme = ExtensionContext["ui"]["theme"];

function bucketActive(
  bucket: { secondsRemaining?: number | null; windowEnd?: string | null },
  now = Date.now(),
  observedAt = now,
) {
  if (bucket.windowEnd) {
    const end = Date.parse(bucket.windowEnd);
    if (Number.isFinite(end)) return end > now;
  }
  return typeof bucket.secondsRemaining === "number" &&
    observedAt + bucket.secondsRemaining * 1000 > now;
}

function remainingText(
  bucket: { secondsRemaining?: number | null; windowEnd?: string | null },
  now = Date.now(),
  observedAt = now,
) {
  const resetAt = bucket.windowEnd
    ? Date.parse(bucket.windowEnd)
    : observedAt + (bucket.secondsRemaining ?? 0) * 1000;
  const seconds = Number.isFinite(resetAt)
    ? Math.max(0, Math.round((resetAt - now) / 1000))
    : 0;
  if (!seconds || !bucketActive(bucket, now, observedAt)) return "inactive";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function compactPool(
  prefix: string,
  limits: FactoryPoolLimits | undefined,
  observedAt = Date.now(),
) {
  if (!limits) return `${prefix} usage unavailable`;
  const exhausted = exhaustedBucket(limits, Date.now(), observedAt);
  if (exhausted === "monthly") return `${prefix} used · M 100% · children inactive`;
  if (exhausted === "weekly") {
    return `${prefix} used · M ${limits.monthly.usedPercent}% · W 100% · 5h inactive`;
  }
  const parts = [
    bucketActive(limits.monthly, Date.now(), observedAt) ? `M ${limits.monthly.usedPercent}%` : undefined,
    bucketActive(limits.weekly, Date.now(), observedAt) ? `W ${limits.weekly.usedPercent}%` : undefined,
    bucketActive(limits.fiveHour, Date.now(), observedAt) ? `5h ${limits.fiveHour.usedPercent}%` : undefined,
  ].filter(Boolean);
  return `${prefix} used · ${parts.join(" · ") || "fresh window"}`;
}

function accountState(account: FactoryDashboardAccount) {
  if (account.cooldownSeconds && account.cooldownSeconds > 0) return "cooldown";
  if (account.record?.error) return "refresh error";
  const observedAt = account.record?.fetchedAt ?? Date.now();
  const standard = exhaustedBucket(account.record?.limits?.standard, Date.now(), observedAt);
  const core = exhaustedBucket(account.record?.limits?.core, Date.now(), observedAt);
  if (standard && core) return "exhausted";
  if (standard || core) return `${standard ? "standard" : "core"} exhausted`;
  return account.record?.limits ? "ready" : "not refreshed";
}

function stateColor(state: string) {
  if (state === "ready") return "success" as const;
  if (state === "not refreshed") return "muted" as const;
  if (state === "refresh error") return "error" as const;
  return "warning" as const;
}

export class FactoryDashboard implements Component {
  private selected = 0;
  private refreshing = false;
  private closed = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private snapshot: FactoryDashboardSnapshot;
  private readonly refreshData: (force: boolean) => Promise<FactoryDashboardSnapshot>;
  private readonly done: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    snapshot: FactoryDashboardSnapshot,
    refreshData: (force: boolean) => Promise<FactoryDashboardSnapshot>,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.snapshot = snapshot;
    this.refreshData = refreshData;
    this.done = done;
  }

  startRefresh(force: boolean) {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    this.tui.requestRender();
    void this.refreshData(force)
      .then((snapshot) => {
        if (this.closed) return;
        const selectedId = this.snapshot.accounts[this.selected]?.id;
        this.snapshot = snapshot;
        const nextIndex = selectedId
          ? snapshot.accounts.findIndex((account) => account.id === selectedId)
          : -1;
        this.selected = nextIndex >= 0
          ? nextIndex
          : Math.min(this.selected, Math.max(0, snapshot.accounts.length - 1));
      })
      .catch((error) => {
        if (this.closed) return;
        this.snapshot = {
          ...this.snapshot,
          warning: `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      })
      .finally(() => {
        if (this.closed) return;
        this.refreshing = false;
        this.tui.requestRender();
      });
  }

  dispose() {
    this.closed = true;
  }

  invalidate() {}

  handleInput(data: string) {
    const accounts = this.snapshot.accounts;
    if (this.keys.matches(data, "tui.select.cancel")) {
      this.closed = true;
      this.done();
      return;
    }
    if (this.keys.matches(data, "tui.select.up") || data === "k") {
      if (accounts.length) {
        this.selected = (this.selected - 1 + accounts.length) % accounts.length;
      }
    } else if (this.keys.matches(data, "tui.select.down") || data === "j") {
      if (accounts.length) this.selected = (this.selected + 1) % accounts.length;
    } else if (data === "r") {
      this.startRefresh(true);
    }
    this.tui.requestRender();
  }

  render(width: number) {
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(8, rows - 7);
    const accounts = this.snapshot.accounts;
    this.selected = Math.min(this.selected, Math.max(0, accounts.length - 1));
    const selected = accounts[this.selected];
    const ready = `${this.snapshot.active}/${this.snapshot.configured} active`;
    const headerRight = this.refreshing
      ? this.theme.fg("warning", "refreshing…")
      : this.snapshot.warning
        ? this.theme.fg("warning", oneLine(this.snapshot.warning))
        : this.theme.fg("muted", `${ready} · ${this.snapshot.modelCount} models · Droid ${this.snapshot.version}`);
    const title = `  ${this.theme.fg("accent", this.theme.bold("Factory"))} ${this.theme.fg("dim", `· ${this.snapshot.authentication}`)}`;
    const lines = width >= 60
      ? [joinSides(title, `${headerRight}  `, width)]
      : [truncateToWidth(title, width, ""), truncateToWidth(`  ${headerRight}`, width, "")];
    lines.push(
      frameTop(this.theme, width, `${accounts.length} account${accounts.length === 1 ? "" : "s"} · percentages are used`),
    );
    const innerWidth = Math.max(1, width - 2);
    if (width >= 104 && selected) {
      const leftWidth = Math.max(46, Math.floor((innerWidth - 1) * 0.48));
      const rightWidth = Math.max(24, innerWidth - leftWidth - 1);
      const list = this.renderAccounts(leftWidth, bodyHeight, true);
      const detail = this.renderDetail(selected, rightWidth, bodyHeight);
      for (let row = 0; row < bodyHeight; row++) {
        lines.push(
          this.theme.fg("border", "│") +
          padLine(list[row] ?? "", leftWidth) +
          this.theme.fg("borderMuted", "│") +
          padLine(detail[row] ?? "", rightWidth) +
          this.theme.fg("border", "│"),
        );
      }
    } else {
      const list = this.renderAccounts(innerWidth, bodyHeight, false);
      for (let row = 0; row < bodyHeight; row++) {
        lines.push(
          this.theme.fg("border", "│") +
          padLine(list[row] ?? "", innerWidth) +
          this.theme.fg("border", "│"),
        );
      }
    }
    lines.push(frameBottom(this.theme, width));
    lines.push(
      truncateToWidth(
        this.theme.fg("dim", "  ↑↓/jk select · r refresh all accounts · esc close"),
        width,
        "",
      ),
    );
    return lines.map((line) => truncateToWidth(line, width, ""));
  }

  private renderAccounts(width: number, height: number, compact: boolean) {
    const accounts = this.snapshot.accounts;
    if (!accounts.length) {
      return [
        this.theme.fg("muted", " No Factory credentials configured."),
        this.theme.fg("dim", " Run /login factory to configure an account or API-key file."),
      ];
    }
    const rowsPerAccount = compact ? 1 : 4;
    const visibleCount = Math.max(1, Math.floor(height / rowsPerAccount));
    const start = Math.min(
      Math.max(0, this.selected - Math.floor(visibleCount / 2)),
      Math.max(0, accounts.length - visibleCount),
    );
    const visible = accounts.slice(start, start + visibleCount);
    const lines: string[] = [];
    for (const [offset, account] of visible.entries()) {
      const index = start + offset;
      const selected = index === this.selected;
      const state = accountState(account);
      const marker = selected ? this.theme.fg("accent", "❯") : " ";
      const title = this.theme.fg(selected ? "accent" : "text", oneLine(account.label));
      const status = stateLabel(this.theme, stateColor(state), state);
      const first = joinSides(` ${marker} ${title}`, `${status} `, width);
      lines.push(selected ? this.theme.bg("selectedBg", padLine(first, width)) : first);
      if (!compact) {
        lines.push(`   ${this.theme.fg("muted", compactPool("Standard", account.record?.limits?.standard, account.record?.fetchedAt))}`);
        lines.push(`   ${this.theme.fg("muted", compactPool("Core", account.record?.limits?.core, account.record?.fetchedAt))}`);
        lines.push("");
      }
    }
    if (start > 0 && lines.length) lines[0] = this.theme.fg("dim", `   ↑ ${start} more`);
    const below = accounts.length - start - visible.length;
    if (below > 0 && lines.length) lines[lines.length - 1] = this.theme.fg("dim", `   ↓ ${below} more`);
    return lines.slice(0, height);
  }

  private renderDetail(account: FactoryDashboardAccount, width: number, height: number) {
    const state = accountState(account);
    const lines = [
      ` ${stateLabel(this.theme, stateColor(state), state)} ${this.theme.fg("accent", this.theme.bold(oneLine(account.label)))}`,
      account.record
        ? ` ${this.theme.fg("dim", `updated ${Math.max(0, Math.floor((Date.now() - account.record.fetchedAt) / 60_000))}m ago`)}`
        : ` ${this.theme.fg("dim", "usage has not been refreshed")}`,
    ];
    if (account.cooldownSeconds) {
      lines.push(` ${this.theme.fg("warning", `rotation cooldown ${remainingText({ secondsRemaining: account.cooldownSeconds })}`)}`);
    }
    if (account.record?.error) {
      lines.push(` ${this.theme.fg("error", oneLine(account.record.error))}`);
    }
    lines.push("", ...this.renderPool("Standard", account.record?.limits?.standard, width, account.record?.fetchedAt));
    lines.push("", ...this.renderPool("Droid Core", account.record?.limits?.core, width, account.record?.fetchedAt));
    if (account.lastUsedAt) {
      lines.push("", ` ${this.theme.fg("muted", "LAST USED")} ${this.theme.fg("text", account.lastUsedAt)}`);
    }
    return lines.slice(0, height);
  }

  private renderPool(
    name: string,
    limits: FactoryPoolLimits | undefined,
    width: number,
    observedAt = Date.now(),
  ) {
    const lines = [` ${this.theme.fg("accent", this.theme.bold(`${name} · used`))}`];
    if (!limits) return [...lines, ` ${this.theme.fg("muted", "Unavailable")}`];
    const exhausted = exhaustedBucket(limits, Date.now(), observedAt);
    const windows = [
      ["MONTHLY", limits.monthly, false],
      ["WEEKLY", limits.weekly, exhausted === "monthly"],
      ["5-HOUR", limits.fiveHour, exhausted === "monthly" || exhausted === "weekly"],
    ] as const;
    for (const [label, bucket, suppressed] of windows) {
      const isActive = bucketActive(bucket, Date.now(), observedAt) && !suppressed;
      const state = bucket.usedPercent >= 100 && isActive
        ? "error"
        : bucket.usedPercent >= 85 && isActive
          ? "warning"
          : "active";
      const value = isActive ? bucket.usedPercent : 0;
      lines.push(` ${this.theme.fg("muted", label.padEnd(7))} ${meter(this.theme, value, 100, Math.max(12, width - 21), isActive ? state : "muted")} ${this.theme.fg("dim", suppressed ? "parent exhausted" : remainingText(bucket, Date.now(), observedAt))}`);
    }
    return lines;
  }
}

export async function openFactoryDashboard(
  ctx: ExtensionContext,
  initial: FactoryDashboardSnapshot,
  refresh: (force: boolean) => Promise<FactoryDashboardSnapshot>,
) {
  await ctx.ui.custom<void>(
    (tui, theme, keys, done) => {
      const dashboard = new FactoryDashboard(
        tui,
        theme,
        keys,
        initial,
        refresh,
        () => done(undefined),
      );
      queueMicrotask(() => dashboard.startRefresh(false));
      return dashboard;
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
