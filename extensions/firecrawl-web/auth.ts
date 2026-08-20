import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FirecrawlConfig = {
  apiKey: string;
  apiUrl: string;
  source: "environment" | "pi-env" | "firecrawl-cli";
};

type ResolveOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  agentDir?: string;
};

const DEFAULT_API_URL = "https://api.firecrawl.dev";

function parseEnvFile(file: string): Record<string, string> {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }

  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]] = value;
  }
  return values;
}

function cliCredentialsPath(home: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "firecrawl-cli", "credentials.json");
  if (platform === "win32") return join(home, "AppData", "Roaming", "firecrawl-cli", "credentials.json");
  return join(home, ".config", "firecrawl-cli", "credentials.json");
}

function readCliCredentials(home: string, platform: NodeJS.Platform): { apiKey?: string; apiUrl?: string } {
  try {
    const value = JSON.parse(readFileSync(cliCredentialsPath(home, platform), "utf8")) as Record<string, unknown>;
    return {
      apiKey: typeof value.apiKey === "string" ? value.apiKey : undefined,
      apiUrl: typeof value.apiUrl === "string" ? value.apiUrl : undefined,
    };
  } catch {
    return {};
  }
}

function normalizeApiUrl(value: string | undefined): string {
  const input = value?.trim() || DEFAULT_API_URL;
  const url = new URL(input);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("Firecrawl API URL must use HTTPS (or localhost HTTP).");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function resolveFirecrawlConfig(options: ResolveOptions = {}): FirecrawlConfig {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const agentDir = options.agentDir ?? (options.home === undefined ? getAgentDir() : join(home, ".pi", "agent"));
  const piEnv = parseEnvFile(join(agentDir, ".env"));
  const cli = readCliCredentials(home, platform);

  const envKey = env.FIRECRAWL_API_KEY?.trim();
  const piKey = piEnv.FIRECRAWL_API_KEY?.trim();
  const cliKey = cli.apiKey?.trim();
  const apiKey = envKey || piKey || cliKey;
  if (!apiKey) {
    throw new Error("Firecrawl authentication is unavailable. Log in with `firecrawl login` or set FIRECRAWL_API_KEY.");
  }

  const source: FirecrawlConfig["source"] = envKey ? "environment" : piKey ? "pi-env" : "firecrawl-cli";
  const apiUrl = normalizeApiUrl(env.FIRECRAWL_API_URL || piEnv.FIRECRAWL_API_URL || cli.apiUrl);
  return { apiKey, apiUrl, source };
}
