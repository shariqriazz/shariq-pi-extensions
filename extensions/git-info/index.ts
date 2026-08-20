import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadChangedFiles,
  loadGitSummary,
  loadPullRequest,
  type GitSummary,
} from "./src/git.ts";
import { openGitChanges } from "./src/ui.ts";

const STATUS_KEY = "git-info";
const REFRESH_DEBOUNCE_MS = 150;

function statusText(ui: ExtensionUIContext, summary: GitSummary): string | undefined {
  if (!summary.isRepository || !summary.branch) return undefined;
  const changed = summary.changedFiles === 0
    ? ui.theme.fg("muted", "clean")
    : ui.theme.fg(
        "warning",
        `${summary.changedFiles} changed ${summary.changedFiles === 1 ? "file" : "files"}`,
      );
  const pr = summary.pullRequest
    ? ` · ${ui.theme.fg("accent", `PR #${summary.pullRequest.number}${summary.pullRequest.draft ? " draft" : ""}`)}`
    : "";
  return `${ui.theme.fg("muted", "git")} ${ui.theme.fg("accent", summary.branch)} · ${changed}${pr} · ${ui.theme.fg("dim", "/lg")}`;
}

export default function gitInfoExtension(pi: ExtensionAPI) {
  let ui: ExtensionUIContext | undefined;
  let summary: GitSummary = { isRepository: false, changedFiles: 0 };
  let generation = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshSequence = 0;

  const publish = () => ui?.setStatus(STATUS_KEY, statusText(ui, summary));

  const refresh = async (ctx: ExtensionContext, expectedGeneration: number) => {
    const sequence = ++refreshSequence;
    try {
      const next = await loadGitSummary(pi, ctx.cwd);
      if (generation !== expectedGeneration || sequence !== refreshSequence) return;
      const sameBranch = next.branch && next.branch === summary.branch;
      summary = {
        ...next,
        pullRequest: sameBranch ? summary.pullRequest : undefined,
      };
      publish();
    } catch {
      if (generation === expectedGeneration && sequence === refreshSequence) {
        summary = { isRepository: false, changedFiles: 0 };
        publish();
      }
    }
  };

  const scheduleRefresh = (ctx: ExtensionContext) => {
    if (!ui) return;
    const expectedGeneration = generation;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh(ctx, expectedGeneration);
    }, REFRESH_DEBOUNCE_MS);
    refreshTimer.unref?.();
  };

  pi.on("session_start", (_event, ctx) => {
    generation++;
    summary = { isRepository: false, changedFiles: 0 };
    if (ctx.hasUI) ui = ctx.ui;
    void refresh(ctx, generation);
  });
  pi.on("input", (_event, ctx) => {
    scheduleRefresh(ctx);
    return { action: "continue" };
  });
  pi.on("tool_execution_end", (_event, ctx) => scheduleRefresh(ctx));
  pi.on("session_shutdown", () => {
    generation++;
    refreshSequence++;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    ui?.setStatus(STATUS_KEY, undefined);
    ui = undefined;
  });

  pi.registerCommand("lg", {
    description: "Browse changed files and diffs in the current Git repository",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("The Git changes viewer requires the TUI", "warning");
        return;
      }
      type LoadOutcome =
        | { loaded: Awaited<ReturnType<typeof loadChangedFiles>> }
        | { error: string }
        | null;
      const outcome = await ctx.ui.custom<LoadOutcome>((tui, theme, _keybindings, done) => {
        const loader = new BorderedLoader(tui, theme, "Loading Git changes…");
        let settled = false;
        const finish = (value: LoadOutcome) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        loader.onAbort = () => finish(null);
        loadChangedFiles(pi, ctx.cwd, loader.signal).then(
          (loaded) => finish({ loaded }),
          (error: unknown) => {
            if (loader.signal.aborted) finish(null);
            else finish({ error: error instanceof Error ? error.message : String(error) });
          },
        );
        return loader;
      });
      if (!outcome) {
        ctx.ui.notify("Git changes load cancelled", "info");
        return;
      }
      if ("error" in outcome) {
        ctx.ui.notify(`Could not load Git changes: ${outcome.error}`, "error");
        return;
      }
      const { loaded } = outcome;
      if (!loaded) {
        ctx.ui.notify("Not a Git repository", "warning");
        return;
      }
      if (loaded.files.length === 0) {
        ctx.ui.notify("Working tree is clean", "info");
        return;
      }
      await openGitChanges(ctx, loaded.root, loaded.files, loaded.omitted);
    },
  });

  pi.registerCommand("pr", {
    description: "Refresh pull-request information for the current branch",
    handler: async (_args, ctx) => {
      const next = await loadGitSummary(pi, ctx.cwd);
      if (!next.isRepository) {
        ctx.ui.notify("Not a Git repository", "warning");
        return;
      }
      const pullRequest = await loadPullRequest(pi, next.root ?? ctx.cwd);
      summary = { ...next, pullRequest };
      publish();
      if (!pullRequest) {
        ctx.ui.notify(`No open pull request found for ${next.branch ?? "this branch"}`, "info");
        return;
      }
      ctx.ui.notify(
        `PR #${pullRequest.number}${pullRequest.draft ? " (draft)" : ""}: ${pullRequest.url}`,
        "info",
      );
    },
  });
}
