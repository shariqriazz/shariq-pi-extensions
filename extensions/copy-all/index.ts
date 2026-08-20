import {
  copyToClipboard,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object" || !("type" in block)) return "";
      if (
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function formatConversation(
  messages: ReadonlyArray<{ role?: unknown; content?: unknown }>,
): string {
  return messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: String(message.role).toUpperCase(),
      text: textFromMessageContent(message.content),
    }))
    .filter((message) => message.text)
    .map((message) => `${message.role}:\n${message.text}`)
    .join("\n\n---\n\n");
}

export default function copyAllExtension(pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description: "Copy visible user and assistant text from the current branch",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const messages = ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);
      const visibleMessages = messages.filter(
        (message) => message.role === "user" || message.role === "assistant",
      );
      const transcript = formatConversation(visibleMessages);
      if (!transcript) {
        ctx.ui.notify("No user or assistant messages to copy", "info");
        return;
      }
      try {
        await copyToClipboard(transcript);
      } catch (error) {
        ctx.ui.notify(
          `Could not copy the conversation: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        return;
      }
      ctx.ui.notify(`Copied ${visibleMessages.length} branch messages`, "info");
    },
  });
}
