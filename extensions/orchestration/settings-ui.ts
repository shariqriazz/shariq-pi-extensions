import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { openModelPicker } from "../shared/model-picker.ts";
import { frameBottom, frameTop, framedRow, joinSides, padLine } from "../shared/tui-dashboard.ts";
import {
  loadOrchestrationSettings,
  saveOrchestrationSettings,
} from "./settings.ts";
import {
  ORCHESTRATION_ROLES,
  type OrchestrationRole,
  type OrchestrationSettings,
} from "./types.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type OrchestrationSettingsAction =
  | { kind: "close" }
  | { kind: "save" }
  | { kind: "pick-model"; role: OrchestrationRole };

export class OrchestrationSettingsComponent {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly settings: OrchestrationSettings;
  private readonly done: (action: OrchestrationSettingsAction) => void;
  private selected = 0;
  private closed = false;
  public changed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    settings: OrchestrationSettings,
    done: (action: OrchestrationSettingsAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.settings = settings;
    this.done = done;
  }

  private close(action: OrchestrationSettingsAction) {
    if (this.closed) return;
    this.closed = true;
    this.done(action);
  }

  dispose() {
    this.closed = true;
  }

  invalidate() {}

  private cycleThinking(role: OrchestrationRole) {
    const current = this.settings.roles[role].thinking;
    const currentIndex = THINKING.indexOf(current as (typeof THINKING)[number]);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % THINKING.length : 0;
    this.settings.roles[role].thinking = THINKING[nextIndex];
    this.changed = true;
    this.tui.requestRender();
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.escape)) {
      this.close({ kind: "close" });
      return;
    }

    if (this.keys.matches(data, "tui.select.up") || data === "k" || matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }

    if (this.keys.matches(data, "tui.select.down") || data === "j" || matchesKey(data, Key.down)) {
      this.selected = Math.min(ORCHESTRATION_ROLES.length - 1, this.selected + 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.return) || matchesKey(data, Key.enter) || data === "e") {
      const role = ORCHESTRATION_ROLES[this.selected];
      if (role) this.close({ kind: "pick-model", role });
      return;
    }

    if (data === "t" || matchesKey(data, Key.tab) || data === " ") {
      const role = ORCHESTRATION_ROLES[this.selected];
      if (role) this.cycleThinking(role);
      return;
    }

    if (data === "s") {
      this.close({ kind: "save" });
      return;
    }
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(8, rows - 5);
    const innerWidth = Math.max(1, width - 2);

    const bodyLines: string[] = [
      ` ${this.theme.fg("muted", "Configure role models and reasoning effort.")}`,
      this.theme.fg("borderMuted", "─".repeat(innerWidth)),
      "",
    ];

    for (const [index, role] of ORCHESTRATION_ROLES.entries()) {
      const isSel = index === this.selected;
      const config = this.settings.roles[role] ?? { thinking: "medium" as const };
      const marker = isSel ? this.theme.fg("accent", "❯") : " ";

      const roleLabel = isSel
        ? this.theme.fg("accent", this.theme.bold(role.padEnd(14)))
        : this.theme.fg("text", role.padEnd(14));

      const modelText = config.model
        ? this.theme.fg("accent", config.model)
        : this.theme.fg("error", "not configured (press Enter to choose)");

      const thinkingText = this.theme.fg("dim", `⚡ ${config.thinking ?? "medium"}`);

      const left = ` ${marker} ${roleLabel} ${modelText}`;
      const row = joinSides(left, `${thinkingText} `, innerWidth);
      bodyLines.push(isSel ? this.theme.bg("selectedBg", row) : row);
    }

    bodyLines.push("");
    bodyLines.push(` ${this.theme.fg("dim", "Tips: Press Enter to open Searchable Model Picker · Press t / Tab to cycle thinking level")}`);

    const lines = [
      joinSides(`  ${this.theme.fg("accent", this.theme.bold("◆ ORCHESTRATION SETTINGS"))}`, `${this.theme.fg("muted", "5 roles")}  `, width),
      frameTop(this.theme, width, "ROLE CONFIGURATION"),
    ];

    for (let row = 0; row < bodyHeight; row++) {
      lines.push(framedRow(this.theme, bodyLines[row] ?? "", width));
    }

    lines.push(frameBottom(this.theme, width));
    lines.push(truncateToWidth(this.theme.fg("dim", "  j/k navigate · enter pick model · t cycle thinking · s save · esc close"), width, ""));

    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}

export async function openOrchestrationSettings(ctx: ExtensionContext): Promise<boolean> {
  const settings = loadOrchestrationSettings();
  let changed = false;

  if (!ctx.hasUI) return false;

  while (true) {
    let component: OrchestrationSettingsComponent | undefined;
    const action = await ctx.ui.custom<OrchestrationSettingsAction>(
      (tui, theme, keys, done) => {
        component = new OrchestrationSettingsComponent(tui, theme, keys, settings, done);
        return component;
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );

    if (component?.changed) changed = true;

    if (!action || action.kind === "close") {
      break;
    }

    if (action.kind === "save") {
      if (changed) {
        saveOrchestrationSettings(settings);
        ctx.ui.notify("Orchestration settings saved.", "info");
      }
      return changed;
    }

    if (action.kind === "pick-model") {
      const selectedModel = await openModelPicker(ctx, {
        title: `Model for ${action.role}`,
        currentModel: settings.roles[action.role].model,
      });
      if (selectedModel && selectedModel !== settings.roles[action.role].model) {
        settings.roles[action.role].model = selectedModel;
        changed = true;
      }
    }
  }

  if (changed) {
    saveOrchestrationSettings(settings);
    ctx.ui.notify("Orchestration settings saved.", "info");
  }
  return changed;
}
