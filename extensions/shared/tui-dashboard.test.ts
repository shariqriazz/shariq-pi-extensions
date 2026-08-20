import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  frameBottom,
  framedRow,
  frameTop,
  joinSides,
  meter,
  sanitizeTerminalText,
} from "./tui-dashboard.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
} as any;

test("dashboard primitives never exceed the requested width", () => {
  for (const width of [8, 20, 47, 100]) {
    const lines = [
      frameTop(theme, width, "a very long panel title that must fit"),
      framedRow(theme, "a long row that also needs to be safely truncated", width, true),
      joinSides("left side that can shrink", "right", width),
      frameBottom(theme, width),
      meter(theme, 73, 100, width),
    ];
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
});

test("terminal sanitization removes cursor, title, control, and tab sequences", () => {
  const dirty = "safe\u001b]0;owned\u0007\u001b[2J\u001b[H\ttext\u0000";
  assert.equal(sanitizeTerminalText(dirty), "safe  text");
});
