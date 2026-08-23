import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SettlementMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

/**
 * Hand settlement to Pi as an extension-originated user follow-up. A custom
 * message can wake the parent yet fail to appear in the invoked model turn;
 * sendUserMessage guarantees that the bounded result is model-visible. Pi
 * starts a turn when idle and queues the same input while the parent is active.
 */
export function deliverSettlement(pi: ExtensionAPI, message: SettlementMessage): void {
  const content = typeof message.content === "string"
    ? message.content
    : message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
  pi.sendUserMessage(content, { deliverAs: "followUp" });
}
