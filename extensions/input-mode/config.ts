import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const INPUT_MODES = ["steer", "interrupt", "follow-up"] as const;
export type InputMode = (typeof INPUT_MODES)[number];

interface InputModeDocument {
  version: 1;
  mode: InputMode;
}

export function inputModePath(): string {
  return path.join(getAgentDir(), "input-mode.json");
}

export function isInputMode(value: unknown): value is InputMode {
  return typeof value === "string" && INPUT_MODES.includes(value as InputMode);
}

export function loadInputMode(file = inputModePath()): InputMode {
  try {
    const document = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<InputModeDocument>;
    return document.version === 1 && isInputMode(document.mode) ? document.mode : "steer";
  } catch {
    return "steer";
  }
}

export function saveInputMode(mode: InputMode, file = inputModePath()): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const document: InputModeDocument = { version: 1, mode };
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup after a failed atomic replacement.
    }
  }
}
