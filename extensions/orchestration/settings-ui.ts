import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ORCHESTRATION_ROLES } from "./types.ts";
import {
  loadOrchestrationSettings,
  saveOrchestrationSettings,
} from "./settings.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export async function openOrchestrationSettings(ctx: ExtensionContext) {
  const settings = loadOrchestrationSettings();
  for (;;) {
    const choices = [
      ...ORCHESTRATION_ROLES.map((role) =>
        `${role}: ${settings.roles[role].model ?? "not configured"} · ${settings.roles[role].thinking}`,
      ),
      "done",
    ];
    const selected = await ctx.ui.select("Orchestration role models", choices);
    if (!selected || selected === "done") break;
    const role = ORCHESTRATION_ROLES.find((candidate) => selected.startsWith(`${candidate}:`));
    if (!role) continue;
    const models = ctx.modelRegistry
      .getAll()
      .map((model) => `${model.provider}/${model.id}`)
      .sort();
    const model = await ctx.ui.select(`Model for ${role}`, models);
    if (!model) continue;
    const thinking = await ctx.ui.select(
      `Thinking level for ${role}`,
      [...THINKING],
    );
    settings.roles[role] = {
      model,
      thinking: (thinking as (typeof THINKING)[number] | undefined) ?? settings.roles[role].thinking,
    };
    saveOrchestrationSettings(settings);
  }
  saveOrchestrationSettings(settings);
  ctx.ui.notify("Orchestration settings saved.", "info");
}
