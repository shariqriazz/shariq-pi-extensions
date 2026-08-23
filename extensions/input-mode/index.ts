import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  INPUT_MODES,
  isInputMode,
  loadInputMode,
  saveInputMode,
  type InputMode,
} from "./config.ts";

const STATUS_KEY = "input-mode";
type ModelInput = Parameters<ExtensionAPI["sendUserMessage"]>[0];

interface InputModeExtensionOptions {
  configFile?: string;
}

function modelInput(event: InputEvent): ModelInput {
  if (!event.images?.length) return event.text;
  return [{ type: "text" as const, text: event.text }, ...event.images];
}

function mergeInputs(inputs: ModelInput[]): ModelInput {
  if (inputs.length === 1) return inputs[0]!;
  return inputs.flatMap((input, index) => [
    ...(index === 0 ? [] : [{ type: "text" as const, text: "\n\n---\n\n" }]),
    ...(typeof input === "string" ? [{ type: "text" as const, text: input }] : input),
  ]);
}

export function createInputModeExtension(options: InputModeExtensionOptions = {}) {
  return (pi: ExtensionAPI) => {
    let mode = loadInputMode(options.configFile);
    let ui: ExtensionUIContext | undefined;
    const pendingInterrupts: ModelInput[] = [];

    const updateStatus = () => {
      if (!ui) return;
      ui.setStatus(STATUS_KEY, mode === "steer" ? undefined : `input: ${mode}`);
    };

    const selectMode = async (args: string, ctx: ExtensionCommandContext) => {
      const requested = args.trim().toLowerCase();
      let selected: InputMode | undefined;
      if (requested) {
        if (!isInputMode(requested)) {
          ctx.ui.notify(`Usage: /input-mode [${INPUT_MODES.join("|")}]`, "warning");
          return;
        }
        selected = requested;
      } else if (ctx.hasUI) {
        selected = await ctx.ui.select(
          `Input behavior while agent is running (current: ${mode})`,
          [...INPUT_MODES],
        ) as InputMode | undefined;
      } else {
        ctx.ui.notify(`Input mode: ${mode}. Usage: /input-mode [${INPUT_MODES.join("|")}]`, "info");
        return;
      }
      if (!selected) return;
      mode = selected;
      saveInputMode(mode, options.configFile);
      updateStatus();
      const explanation = mode === "interrupt"
        ? "new Enter input aborts the active run before it is delivered"
        : mode === "follow-up"
          ? "new Enter input waits until the active run finishes"
          : "new Enter input is injected before the agent's next step";
      ctx.ui.notify(`Input mode: ${mode} — ${explanation}.`, "info");
    };

    pi.registerCommand("input-mode", {
      description: "Choose Enter behavior while the agent runs: steer, interrupt, or follow-up",
      handler: selectMode,
    });

    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ui = ctx.ui;
      updateStatus();
    });

    pi.on("agent_settled", () => {
      if (pendingInterrupts.length === 0) return;
      const input = mergeInputs(pendingInterrupts.splice(0));
      pi.sendUserMessage(input, { expandPromptTemplates: true });
    });

    pi.on("session_shutdown", () => {
      pendingInterrupts.length = 0;
      ui?.setStatus(STATUS_KEY, undefined);
      ui = undefined;
    });

    pi.on("input", (event, ctx): InputEventResult => {
      // Extension-originated results and explicit Alt+Enter follow-ups retain
      // their requested delivery. Idle input and commands use Pi unchanged.
      if (event.source !== "interactive" || event.streamingBehavior !== "steer") {
        return { action: "continue" };
      }
      if (mode === "steer") return { action: "continue" };
      if (mode === "follow-up") {
        pi.sendUserMessage(modelInput(event), { deliverAs: "followUp" });
        return { action: "handled" };
      }

      // Store before signalling abort so even a very fast settlement cannot
      // race past the replacement input. agent_settled is Pi's safe idle edge;
      // it starts one fresh turn after model/tool cancellation completes.
      pendingInterrupts.push(modelInput(event));
      ctx.abort();
      return { action: "handled" };
    });
  };
}

export default createInputModeExtension();
