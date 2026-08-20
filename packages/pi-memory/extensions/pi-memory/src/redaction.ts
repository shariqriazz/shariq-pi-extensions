import path from "node:path";

const SENSITIVE_PATH_PARTS = new Set([
  ".env",
  "auth.json",
  "credentials",
  "credential",
  "secrets",
  "secret",
  "keychain",
  ".ssh",
  ".aws",
  ".gnupg",
]);

const CREDENTIAL_NAME = "(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|cookie|session[_-]?token|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id|client[_-]?secret|private[_-]?key)";

const REDACTIONS: Array<[RegExp, string]> = [
  [/\b(https?:\/\/[^\s/:@]+:)[^\s/@]+@/gi, "$1<redacted>@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer <redacted>"],
  [new RegExp(`(\\b${CREDENTIAL_NAME}\\b\\s*[:=]\\s*)(["'])(.*?)\\2`, "gi"), "$1$2<redacted>$2"],
  [new RegExp(`(\\b${CREDENTIAL_NAME}\\b\\s*[:=]\\s*)[^\\r\\n,;]+`, "gi"), "$1<redacted>"],
  [/\b(?:sk|pk|rk|ghp|github_pat|xox[baprs]|AIza)[-_A-Za-z0-9]{12,}\b/g, "<redacted-token>"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "<redacted-opaque-value>"],
];

export function redactSecrets(value: string): string {
  let result = value;
  for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement);
  return result;
}

export function isSensitivePath(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll("\\", "/");
  return normalized.split("/").some((part) => SENSITIVE_PATH_PARTS.has(part))
    || /(?:^|\/)\.env(?:\.|$)/.test(normalized)
    || /(?:^|\/)(?:id_rsa|id_ed25519|known_hosts)(?:$|\/)/.test(normalized);
}

export function sanitizeToolArguments(toolName: string, input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return "[unserializable arguments]";
  }

  if (["read", "write", "edit"].includes(toolName)) {
    const possiblePath = typeof input === "object" && input !== null && "path" in input
      ? String((input as { path?: unknown }).path ?? "")
      : "";
    if (possiblePath && isSensitivePath(path.normalize(possiblePath))) return "[sensitive path omitted]";
  }

  return redactSecrets(serialized).slice(0, 4_000);
}
