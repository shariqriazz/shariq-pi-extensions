import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { frameBottom, frameTop, framedRow, joinSides, padLine } from "./tui-dashboard.ts";

export type ModelPickerItem = {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  isCurrent?: boolean;
  description?: string;
  value?: string;
};

export type ModelPickerOptions = {
  title?: string;
  currentModel?: string;
  items?: ModelPickerItem[];
  extraChoices?: { id: string; label: string; description?: string; value?: string }[];
};

function formatContextSize(tokens?: number): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
  return `${tokens} ctx`;
}

export class ModelPickerComponent {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly done: (result: string | undefined) => void;
  private readonly allItems: ModelPickerItem[];
  private readonly title: string;
  private readonly searchInput: Input;

  private filteredItems: ModelPickerItem[];
  private selected = 0;
  private closed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keys: KeybindingsManager,
    options: ModelPickerOptions,
    items: ModelPickerItem[],
    done: (result: string | undefined) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keys = keys;
    this.done = done;
    this.allItems = items;
    this.filteredItems = [...items];
    this.title = options.title ?? "Select Model";
    this.searchInput = new Input();

    // If current model is present, highlight its index initially
    const currentIndex = this.filteredItems.findIndex((item) => item.isCurrent);
    if (currentIndex >= 0) this.selected = currentIndex;
  }

  private close(result: string | undefined) {
    if (this.closed) return;
    this.closed = true;
    this.done(result);
  }

  dispose() {
    this.closed = true;
  }

  invalidate() {}

  private refilter() {
    const query = this.searchInput.getValue();
    if (!query.trim()) {
      this.filteredItems = [...this.allItems];
    } else {
      this.filteredItems = fuzzyFilter(this.allItems, query, (item) =>
        `${item.provider} ${item.id} ${item.name ?? ""} ${item.description ?? ""}`,
      );
    }
    this.selected = Math.max(0, Math.min(this.selected, this.filteredItems.length - 1));
  }

  handleInput(data: string) {
    if (matchesKey(data, Key.escape)) {
      this.close(undefined);
      return;
    }

    if (matchesKey(data, Key.return) || matchesKey(data, Key.enter)) {
      const selectedItem = this.filteredItems[this.selected];
      if (selectedItem) {
        this.close(selectedItem.value ?? (selectedItem.provider === "special" ? selectedItem.id : `${selectedItem.provider}/${selectedItem.id}`));
      } else {
        this.close(undefined);
      }
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
      this.selected = Math.min(Math.max(0, this.filteredItems.length - 1), this.selected + 1);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageUp)) {
      const pageSize = Math.max(1, (this.tui.terminal.rows || 30) - 8);
      this.selected = Math.max(0, this.selected - pageSize);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.pageDown)) {
      const pageSize = Math.max(1, (this.tui.terminal.rows || 30) - 8);
      this.selected = Math.min(Math.max(0, this.filteredItems.length - 1), this.selected + pageSize);
      this.tui.requestRender();
      return;
    }

    // Pass character/editing input to the search box
    const previous = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== previous) {
      this.refilter();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows || 30;
    const bodyHeight = Math.max(8, rows - 6);
    const innerWidth = Math.max(1, width - 2);

    const lines: string[] = [];

    // Search header line
    const searchVal = this.searchInput.getValue();
    const prompt = this.theme.fg("accent", "❯ ");
    const placeholder = searchVal ? "" : this.theme.fg("dim", "type to filter models…");
    const inputContent = `${prompt}${searchVal}${placeholder}`;

    // Compute scroll window for items
    const listHeight = Math.max(4, bodyHeight - 2); // 2 rows for search bar and separator
    const total = this.filteredItems.length;
    let start = 0;
    if (total > listHeight) {
      start = Math.min(
        Math.max(0, this.selected - Math.floor(listHeight / 2)),
        total - listHeight,
      );
    }
    const visible = this.filteredItems.slice(start, start + listHeight);

    const bodyLines: string[] = [
      ` ${padLine(inputContent, innerWidth - 2)}`,
      this.theme.fg("borderMuted", "─".repeat(innerWidth)),
    ];

    if (!visible.length) {
      bodyLines.push(` ${this.theme.fg("muted", "No models match your search.")}`);
    } else {
      for (const [offset, item] of visible.entries()) {
        const index = start + offset;
        const isSel = index === this.selected;
        const marker = isSel ? this.theme.fg("accent", "❯") : item.isCurrent ? this.theme.fg("success", "✓") : " ";

        const providerBadge = item.provider === "special"
          ? ""
          : `${this.theme.fg("dim", "[")}${this.theme.fg("muted", item.provider)}${this.theme.fg("dim", "]")} `;

        const nameText = item.name && item.name !== item.id
          ? `${item.name} ${this.theme.fg("dim", `(${item.id})`)}`
          : item.id;

        const mainText = isSel
          ? this.theme.fg("accent", this.theme.bold(nameText))
          : this.theme.fg("text", nameText);

        const metaParts: string[] = [];
        if (item.contextWindow) metaParts.push(formatContextSize(item.contextWindow));
        if (item.reasoning) metaParts.push("⚡ thinking");
        if (item.description) metaParts.push(item.description);
        const metaText = metaParts.length ? this.theme.fg("dim", metaParts.join(" · ")) : "";

        const rowLeft = ` ${marker} ${providerBadge}${mainText}`;
        const row = joinSides(rowLeft, metaText ? `${metaText} ` : " ", innerWidth);
        bodyLines.push(isSel ? this.theme.bg("selectedBg", row) : row);
      }
    }

    // Add scroll indicators if list overflows
    if (start > 0 && bodyLines.length > 2) {
      bodyLines[2] = ` ${this.theme.fg("dim", `↑ ${start} more`)}`;
    }
    const below = total - start - visible.length;
    if (below > 0 && bodyLines.length > 2) {
      bodyLines[bodyLines.length - 1] = ` ${this.theme.fg("dim", `↓ ${below} more`)}`;
    }

    // Top status line and framing
    const status = `${this.filteredItems.length} model${this.filteredItems.length === 1 ? "" : "s"}`;
    lines.push(
      joinSides(`  ${this.theme.fg("accent", this.theme.bold("◆ " + this.title.toUpperCase()))}`, `${this.theme.fg("muted", status)}  `, width),
      frameTop(this.theme, width, this.title),
    );

    // Frame each line
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(framedRow(this.theme, bodyLines[i] ?? "", width));
    }

    lines.push(frameBottom(this.theme, width));
    lines.push(truncateToWidth(this.theme.fg("dim", "  ↑/↓ navigate · enter select · esc cancel"), width, ""));

    return lines.map((line) => truncateToWidth(line, width, ""));
  }
}

export function buildModelPickerItems(
  ctx: ExtensionContext,
  options: ModelPickerOptions = {},
): ModelPickerItem[] {
  const items: ModelPickerItem[] = [];

  if (options.extraChoices) {
    for (const choice of options.extraChoices) {
      items.push({
        provider: "special",
        id: choice.id,
        name: choice.label,
        description: choice.description,
        value: choice.value ?? choice.id,
        isCurrent: options.currentModel === choice.id || options.currentModel === choice.value,
      });
    }
  }

  // Show models from active / configured providers, exactly matching Pi's native /model selector
  const available = ctx.modelRegistry.getAvailable ? ctx.modelRegistry.getAvailable() : [];
  const models = available.length > 0 ? available : (ctx.modelRegistry.getAll ? ctx.modelRegistry.getAll() : []);

  for (const model of models) {
    const fullId = `${model.provider}/${model.id}`;
    items.push({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      value: fullId,
      isCurrent: options.currentModel === fullId || options.currentModel === model.id,
    });
  }

  return items;
}

export async function openModelPicker(
  ctx: ExtensionContext,
  options: ModelPickerOptions = {},
): Promise<string | undefined> {
  const items = options.items ?? buildModelPickerItems(ctx, options);

  return ctx.ui.custom<string | undefined>(
    (tui, theme, keys, done) =>
      new ModelPickerComponent(tui, theme, keys, options, items, done),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}
