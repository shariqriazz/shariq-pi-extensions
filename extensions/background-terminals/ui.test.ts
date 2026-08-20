import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TerminalDashboard } from "./src/ui.ts";

const snapshot = {
  id: "term-1",
  title: "Development server",
  command: "npm run dev -- --host 127.0.0.1",
  cwd: "/tmp/project",
  pid: 1234,
  status: "running",
  createdAt: Date.now() - 5_000,
  output: {
    text: "ready on http://127.0.0.1:3000\r\n",
    totalBytes: 32,
    truncatedBytes: 0,
    cursor: 32,
    version: 1,
    spillPath: "/tmp/private.log",
    spillTruncated: false,
  },
  cols: 120,
  rows: 30,
} as any;

test("terminal dashboard renders bounded live PTY metadata and output", () => {
  const listeners = new Set<() => void>();
  const view = {
    list: () => [snapshot],
    get: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    subscribeTo() { return () => {}; },
    requestKill() {},
    requestWrite() {},
    requestResize() {},
  } as any;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const dashboard = new TerminalDashboard(
    { terminal: { rows: 28 }, requestRender() {} } as any,
    theme,
    { matches: () => false, getKeys: () => [] } as any,
    view,
    { index: 0 },
    () => {},
  );
  try {
    const lines = dashboard.render(120);
    const text = lines.join("\n");
    assert.match(text, /Background terminals/);
    assert.match(text, /PTY sessions/);
    assert.match(text, /Development server/);
    assert.match(text, /ready on http:\/\/127\.0\.0\.1:3000/);
    assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  } finally {
    dashboard.dispose();
  }
});
