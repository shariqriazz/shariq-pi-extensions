import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "./domain.ts";

function rootDir() {
  return path.join(getAgentDir(), "subagents", "runs");
}

export function snapshotDirectory(id: string) {
  return path.join(rootDir(), id);
}

export function saveSnapshot(snapshot: SubagentSnapshot) {
  try {
    const directory = snapshotDirectory(snapshot.id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "snapshot.json");
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
  } catch {
    // Best effort persistence
  }
}

export function loadPersistedSnapshots(): SubagentSnapshot[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(rootDir());
  } catch {
    return [];
  }
  const snapshots: SubagentSnapshot[] = [];
  for (const name of names) {
    try {
      const file = path.join(rootDir(), name, "snapshot.json");
      if (!fs.existsSync(file)) continue;
      let snap = JSON.parse(fs.readFileSync(file, "utf8")) as SubagentSnapshot;
      if (!snap.id || !snap.title) continue;
      if (snap.status === "running") {
        snap = {
          ...snap,
          status: "error",
          errorText: "Pi exited or reloaded while this subagent was active.",
        };
      }
      snapshots.push(snap);
    } catch {
      // Best effort recovery
    }
  }
  return snapshots.sort(
    (a, b) => (b.settledAt ?? b.createdAt) - (a.settledAt ?? a.createdAt),
  );
}
