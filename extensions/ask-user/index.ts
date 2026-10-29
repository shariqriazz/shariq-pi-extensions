import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  type Focusable,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { frameBottom, frameTop, oneLine, padLine, sanitizeTerminalText } from "../shared/tui-dashboard.ts";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MAX_ANSWER_LENGTH = 20_000;

const OptionSchema = Type.Object({
  label: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "Short answer shown to the user",
  }),
  description: Type.Optional(
    Type.String({
      maxLength: 500,
      description: "Consequence or clarification",
    }),
  ),
});

const AskUserParameters = Type.Object({
  question: Type.String({
    minLength: 1,
    maxLength: 4_000,
    description: "The one decision the user needs to make",
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: "Distinct choices; the user can also write their own answer",
  }),
});

interface DisplayOption {
  label: string;
  description?: string;
  custom?: boolean;
}

interface Selection {
  answer: string;
  custom: boolean;
  optionIndex?: number;
}

interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  custom: boolean;
  cancelled: boolean;
  unavailable?: boolean;
}

function cleanMultiline(text: string): string {
  return sanitizeTerminalText(text).trim();
}

// Compare labels the way they are displayed (whitespace collapsed), so two
// labels that look identical on screen are rejected as duplicates.
function normalizedChoiceKey(label: string): string {
  return oneLine(label).normalize("NFKC").toLocaleLowerCase("en-US");
}

function normalizeQuestionInput(
  question: string,
  options: ReadonlyArray<{ label: string; description?: string }>,
): { question: string; options: DisplayOption[] } {
  const cleanQuestion = cleanMultiline(question);
  if (!cleanQuestion) throw new Error("question must contain visible text.");
  const cleanOptions = options.map((option) => ({
    label: cleanMultiline(option.label),
    description: option.description ? cleanMultiline(option.description) || undefined : undefined,
  }));
  if (cleanOptions.some((option) => !option.label)) {
    throw new Error("option labels must contain visible text.");
  }
  const keys = cleanOptions.map((option) => normalizedChoiceKey(option.label));
  if (new Set(keys).size !== keys.length) {
    throw new Error("option labels must be distinct after normalization.");
  }
  return { question: cleanQuestion, options: cleanOptions };
}

export function answerMessage(selection: Selection | null): string {
  if (!selection)
    return "The user dismissed the question. Do not guess repeatedly; continue only if a safe path remains, otherwise explain what is blocked.";
  return selection.custom
    ? `The user wrote: ${selection.answer}`
    : `The user selected option ${selection.optionIndex}: ${selection.answer}`;
}

function createEditorTheme(theme: Theme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

export class AskUserView implements Focusable {
  private selected = 0;
  private editing = false;
  private questionOffset = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private _focused = false;
  private readonly question: string;
  private readonly options: DisplayOption[];
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly finish: (selection: Selection | null) => void;
  private readonly editor: Editor;
  private readonly maxRows: () => number;

  constructor(
    question: string,
    options: DisplayOption[],
    theme: Theme,
    requestRender: () => void,
    finish: (selection: Selection | null) => void,
    editor: Editor,
    maxRows: () => number = () => Number.POSITIVE_INFINITY,
  ) {
    this.question = question;
    this.options = options;
    this.theme = theme;
    this.requestRender = requestRender;
    this.finish = finish;
    this.editor = editor;
    this.maxRows = maxRows;
    this.editor.onSubmit = (value) => {
      const answer = cleanMultiline(value).slice(0, MAX_ANSWER_LENGTH);
      if (!answer) {
        this.editing = false;
        this.editor.setText("");
        this.refresh();
        return;
      }
      this.finish({ answer, custom: true });
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.editing;
  }

  private refresh(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.focused = this._focused && this.editing;
    this.requestRender();
  }

  private choose(index: number): void {
    const option = this.options[index];
    if (!option) return;
    if (option.custom) {
      this.selected = index;
      this.editing = true;
      this.refresh();
      return;
    }
    this.finish({ answer: option.label, custom: false, optionIndex: index + 1 });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.finish(null);
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.questionOffset = Math.max(0, this.questionOffset + (matchesKey(data, Key.pageUp) ? -5 : 5));
      this.refresh();
      return;
    }
    if (this.editing) {
      if (matchesKey(data, Key.escape)) {
        this.editing = false;
        this.editor.setText("");
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = (this.selected - 1 + this.options.length) % this.options.length;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.selected = (this.selected + 1) % this.options.length;
      this.refresh();
      return;
    }
    if (/^[1-6]$/.test(data)) {
      const index = Number(data) - 1;
      if (index < this.options.length) this.choose(index);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.choose(this.selected);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.finish(null);
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
    const safeWidth = Math.max(1, width);
    const inner = Math.max(1, safeWidth - 4);
    const questionLines = wrapTextWithAnsi(this.theme.bold(cleanMultiline(this.question)), inner).map((line) =>
      padLine(`  ${this.theme.fg("text", line)}`, safeWidth),
    );

    const rest: string[] = [padLine("", safeWidth)];
    this.options.forEach((option, index) => {
      const active = index === this.selected;
      const marker = option.custom ? "✎" : `${index + 1}.`;
      const prefix = active ? this.theme.fg("accent", "❯") : " ";
      // Wrap long labels so options that differ only near the end stay distinguishable.
      const labelLines = wrapTextWithAnsi(oneLine(option.label), Math.max(8, inner - 4));
      labelLines.forEach((text, lineIndex) => {
        const label = lineIndex === 0 ? `${prefix} ${marker} ${text}` : `${" ".repeat(marker.length + 3)}${text}`;
        rest.push(
          padLine(
            active
              ? this.theme.bg("selectedBg", this.theme.fg("accent", label))
              : this.theme.fg(option.custom ? "muted" : "text", label),
            safeWidth,
          ),
        );
      });
      if (option.description) {
        for (const description of wrapTextWithAnsi(oneLine(option.description), Math.max(8, inner - 4))) {
          rest.push(padLine(`      ${this.theme.fg("muted", description)}`, safeWidth));
        }
      }
    });
    if (this.editing) {
      rest.push(padLine("", safeWidth));
      rest.push(padLine(`  ${this.theme.fg("muted", "Your answer")}`, safeWidth));
      for (const line of this.editor.render(Math.max(10, safeWidth - 4))) {
        rest.push(padLine(`  ${line}`, safeWidth));
      }
    }
    rest.push(padLine("", safeWidth));

    // Keep the choices, editor, and controls on screen; a long question scrolls.
    const questionRoom = this.maxRows() - rest.length - 3;
    let visibleQuestion = questionLines;
    let scrollHint = "";
    if (questionLines.length > questionRoom) {
      const room = Math.max(1, questionRoom);
      this.questionOffset = Math.min(this.questionOffset, Math.max(0, questionLines.length - room));
      visibleQuestion = questionLines.slice(this.questionOffset, this.questionOffset + room);
      scrollHint = `pgup/pgdn question ${this.questionOffset + 1}-${this.questionOffset + visibleQuestion.length}/${questionLines.length} · `;
    }

    const controls = this.editing
      ? "enter submit · escape choices · ctrl+c dismiss"
      : `up/down or 1-${this.options.length} choose · enter confirm · escape dismiss`;
    const lines = [
      frameTop(this.theme, safeWidth, "Decision needed"),
      ...visibleQuestion,
      ...rest,
      padLine(`  ${this.theme.fg("dim", `${scrollHint}${controls}`)}`, safeWidth),
      frameBottom(this.theme, safeWidth),
    ];
    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, safeWidth, ""));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.editor.invalidate();
  }
}

async function openQuestion(
  ctx: ExtensionContext,
  question: string,
  options: DisplayOption[],
  signal: AbortSignal | undefined,
): Promise<Selection | null> {
  if (ctx.mode !== "tui") return null;
  return ctx.ui.custom<Selection | null>(
    (tui, theme, _keybindings, done) => {
      let settled = false;
      const complete = (selection: Selection | null) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        done(selection);
      };
      const abort = () => complete(null);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) queueMicrotask(abort);
      const view = new AskUserView(
        question,
        options,
        theme,
        () => tui.requestRender(),
        complete,
        new Editor(tui, createEditorTheme(theme)),
        // Matches the overlay's maxHeight (86%) minus its margin.
        () => Math.max(8, Math.floor((tui.terminal.rows || 24) * 0.86) - 2),
      );
      return {
        get focused() {
          return view.focused;
        },
        set focused(value: boolean) {
          view.focused = value;
        },
        render: (width) => view.render(width),
        invalidate: () => view.invalidate(),
        handleInput: (data) => view.handleInput(data),
        dispose: () => signal?.removeEventListener("abort", abort),
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "72%",
        minWidth: 48,
        maxHeight: "86%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

export default function askUserExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask one multiple-choice question only when a missing user decision materially blocks safe progress. Do not use it when the answer is discoverable, the user already supplied it, or a reversible low-risk default is reasonable.",
    promptSnippet: "Ask the user one blocking multiple-choice question.",
    promptGuidelines: [
      "Use ask_user only after checking available context, when a missing choice blocks safe progress and no reversible default fits; ask one decision with distinct options, brief consequences, and the recommended option when one exists.",
    ],
    exposure: "model-only",
    annotations: { readOnlyHint: true, openWorldHint: false },
    parameters: AskUserParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const normalized = normalizeQuestionInput(params.question, params.options);
      if (ctx.mode !== "tui") {
        return {
          content: [
            {
              type: "text",
              text: "Interactive choices are unavailable in this mode. Ask the user plainly in the final response only if the decision still blocks progress.",
            },
          ],
          details: {
            question: normalized.question,
            options: normalized.options.map((option) => option.label),
            answer: null,
            custom: false,
            cancelled: true,
            unavailable: true,
          } satisfies AskUserDetails,
        };
      }
      const choices: DisplayOption[] = [...normalized.options, { label: "Write my own answer…", custom: true }];
      const selection = await openQuestion(ctx, normalized.question, choices, signal);
      const details: AskUserDetails = {
        question: normalized.question,
        options: choices.filter((option) => !option.custom).map((option) => option.label),
        answer: selection?.answer ?? null,
        custom: selection?.custom ?? false,
        cancelled: !selection,
      };
      return {
        content: [{ type: "text", text: answerMessage(selection) }],
        details,
      };
    },
    renderCall(args, theme) {
      const question = typeof args.question === "string" ? oneLine(args.question) : "";
      return {
        render: (width: number) => [
          truncateToWidth(`${theme.fg("toolTitle", theme.bold("ask user"))} ${theme.fg("muted", question)}`, width),
        ],
        invalidate() {},
      };
    },
    renderResult(result, _options, theme, context) {
      const details = result.details as AskUserDetails | undefined;
      const errorText = result.content.find((item) => item.type === "text")?.text ?? "invalid question";
      const text = context.isError
        ? `${theme.fg("error", "● not asked")} ${theme.fg("muted", oneLine(errorText))}`
        : !details || details.cancelled
          ? theme.fg("warning", "● dismissed")
          : `${theme.fg("success", "● answered")} ${theme.fg("accent", oneLine(details.answer ?? ""))}`;
      return { render: (width: number) => [truncateToWidth(text, width)], invalidate() {} };
    },
  });
}
