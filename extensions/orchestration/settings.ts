import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  ORCHESTRATION_ROLES,
  type OrchestrationRole,
  type OrchestrationSettings,
  type RoleSettings,
} from "./types.ts";

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function orchestrationSettingsPath() {
  return path.join(getAgentDir(), "orchestration", "settings.json");
}

export function defaultOrchestrationSettings(): OrchestrationSettings {
  return {
    version: 1,
    maxWorkersPerProject: 10,
    roles: Object.fromEntries(
      ORCHESTRATION_ROLES.map((role) => [role, { thinking: "max" }]),
    ) as Record<OrchestrationRole, RoleSettings>,
  };
}

export function loadOrchestrationSettings(): OrchestrationSettings {
  const fallback = defaultOrchestrationSettings();
  try {
    const raw = JSON.parse(fs.readFileSync(orchestrationSettingsPath(), "utf8")) as Partial<OrchestrationSettings>;
    const roles = { ...fallback.roles };
    for (const role of ORCHESTRATION_ROLES) {
      const candidate = raw.roles?.[role];
      if (!candidate || typeof candidate !== "object") continue;
      roles[role] = {
        model: typeof candidate.model === "string" && candidate.model.trim() ? candidate.model.trim() : undefined,
        thinking: THINKING.has(candidate.thinking) ? candidate.thinking : roles[role].thinking,
      };
    }
    return { version: 1, maxWorkersPerProject: 10, roles };
  } catch {
    return fallback;
  }
}

export function saveOrchestrationSettings(settings: OrchestrationSettings) {
  const file = orchestrationSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function missingRoleModels(settings: OrchestrationSettings) {
  return ORCHESTRATION_ROLES.filter((role) => !settings.roles[role].model);
}
