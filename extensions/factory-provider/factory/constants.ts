import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const PROVIDER_ID = "factory";
export const FACTORY_API_BASE_URL = process.env.FACTORY_API_BASE_URL?.trim() || "https://api.factory.ai";
export const FACTORY_RESPONSES_BASE_URL = `${FACTORY_API_BASE_URL}/api/llm/o/v1`;
export const WORKOS_BASE_URL = "https://api.workos.com/user_management";
export const WORKOS_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB";
export const FACTORY_CLIENT_PROTOCOL = "cli";
export const FALLBACK_DROID_VERSION = "0.200.0";
export const REFRESH_SKEW_MS = 2 * 60 * 1000;

export const DEFAULT_DROID_BINARY = "droid";
export const FACTORY_STATE_DIR = join(getAgentDir(), "factory");
export const DROID_CACHE_PATH = join(FACTORY_STATE_DIR, "droid.json");
