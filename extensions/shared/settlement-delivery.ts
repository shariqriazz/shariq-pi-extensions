import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SettlementMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

/**
 * Hand settlement to Pi immediately. Pi starts a turn when idle and queues the
 * same message as a follow-up when the parent is still running.
 */
export function deliverSettlement(pi: ExtensionAPI, message: SettlementMessage): void {
  pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
}
