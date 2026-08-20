import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadGitSummary, parseChangedPaths, parseNumstat, type ChangedFile } from "./src/git.ts";
import { GitChangesView } from "./src/ui.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const files: ChangedFile[] = [
  {
    path: "src/index.ts",
    name: "index.ts",
    status: " M",
    additions: 3,
    deletions: 1,
    diff: ["diff --git a/src/index.ts b/src/index.ts", "@@ -1 +1 @@", "-old", "+new"],
  },
  {
    path: "README.md",
    name: "README.md",
    status: "??",
    additions: 2,
    deletions: 0,
    diff: ["+hello", "+world"],
  },
];

test("parses NUL-delimited status including rename records", () => {
  assert.deepEqual(
    parseChangedPaths(" M src/a.ts\0R  src/new.ts\0src/old.ts\0?? README.md\0"),
    [
      { status: " M", path: "src/a.ts" },
      { status: "R ", path: "src/new.ts" },
      { status: "??", path: "README.md" },
    ],
  );
  assert.deepEqual(parseNumstat("12\t3\tsrc/a.ts\n"), { additions: 12, deletions: 3 });
  assert.deepEqual(parseNumstat("-\t-\timage.png\n"), { additions: null, deletions: null });
});

test("Git summary preserves repository paths ending in whitespace", async () => {
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const pi = {
    async exec(command: string, args: string[], options: any) {
      calls.push({ command, args, options });
      if (args.includes("--show-toplevel")) return { code: 0, stdout: "/tmp/repo \n", stderr: "" };
      if (args.includes("--show-current")) return { code: 0, stdout: "main\n", stderr: "" };
      if (args.includes("--short")) return { code: 0, stdout: "abc123\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const summary = await loadGitSummary(pi as never, "/tmp");
  assert.equal(summary.root, "/tmp/repo ");
  assert.ok(calls.slice(1).every((call) => call.options.cwd === "/tmp/repo "));
});

test("Git changes dashboard stays within narrow and wide viewports", () => {
  for (const width of [52, 120]) {
    const view = new GitChangesView(files, "/repo", 0, theme, () => 30, () => {}, () => {});
    const list = view.render(width);
    assert.ok(list.some((line) => line.includes("Git changes")));
    for (const line of list) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    view.handleInput("\r");
    const diff = view.render(width);
    assert.ok(diff.some((line) => line.includes("src/index.ts")));
    for (const line of diff) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
});
