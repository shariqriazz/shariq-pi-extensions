import path from "node:path";
import { isSensitivePath, redactSecrets } from "../../shared/redaction.ts";

export { isSensitivePath, redactSecrets } from "../../shared/redaction.ts";

export function hasSensitiveToolArguments(toolName: string, input: unknown): boolean {
  if (!["read", "write", "edit"].includes(toolName)) return false;
  const possiblePath = typeof input === "object" && input !== null && "path" in input
    ? String((input as { path?: unknown }).path ?? "")
    : "";
  return Boolean(possiblePath && isSensitivePath(path.normalize(possiblePath)));
}

export function sanitizeToolArguments(toolName: string, input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return "[unserializable arguments]";
  }

  if (hasSensitiveToolArguments(toolName, input)) return "[sensitive path omitted]";

  return redactSecrets(serialized).slice(0, 4_000);
}
