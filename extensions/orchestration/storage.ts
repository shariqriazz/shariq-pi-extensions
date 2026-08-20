import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OrchestrationRun } from "./types.ts";

function rootDir() {
  return path.join(getAgentDir(), "orchestration", "runs");
}

export function runDirectory(id: string) {
  return path.join(rootDir(), id);
}

export function saveRun(run: OrchestrationRun) {
  const directory = runDirectory(run.id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "run.json");
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

export function loadRuns(): OrchestrationRun[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(rootDir());
  } catch {
    return [];
  }
  const runs: OrchestrationRun[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(
        fs.readFileSync(path.join(rootDir(), name, "run.json"), "utf8"),
      ) as OrchestrationRun;
      if (!value.id || !Array.isArray(value.tasks)) continue;
      if (["planning", "running"].includes(value.status)) {
        value.status = "interrupted";
        value.error = "Pi exited or reloaded while this orchestration was active.";
      }
      runs.push(value);
    } catch {
      // Ignore unreadable run artifacts; other runs remain available.
    }
  }
  return runs.sort((a, b) => b.updatedAt - a.updatedAt);
}
