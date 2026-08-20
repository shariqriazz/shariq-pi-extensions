import { execFileSync } from "child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "path";
import { DEFAULT_DROID_BINARY, DROID_CACHE_PATH, FALLBACK_DROID_VERSION } from "./constants.ts";

type DroidCache = {
  binaryPath: string;
  binaryMtimeMs: number;
  version: string;
  execHelp: string;
};

export function droidPath() {
  const configured = process.env.FACTORY_DROID_BINARY || process.env.DROID_BINARY || DEFAULT_DROID_BINARY;
  const candidates = isAbsolute(configured) || configured.includes("/") || configured.includes("\\")
    ? [resolve(configured)]
    : (process.env.PATH || "").split(delimiter).filter(Boolean).map((dir) => join(dir, configured));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Keep searching PATH; callers retain the configured fallback below.
    }
  }
  return configured;
}

function binaryMtimeMs(path: string) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readCache(): DroidCache | null {
  try {
    if (!existsSync(DROID_CACHE_PATH)) return null;
    const cache = JSON.parse(readFileSync(DROID_CACHE_PATH, "utf8")) as DroidCache;
    const path = droidPath();
    if (cache.binaryPath !== path || cache.binaryMtimeMs !== binaryMtimeMs(path)) return null;
    return cache;
  } catch {
    return null;
  }
}

function writeCache(cache: DroidCache) {
  try {
    mkdirSync(dirname(DROID_CACHE_PATH), { recursive: true, mode: 0o700 });
    writeFileSync(DROID_CACHE_PATH, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // Cache is best-effort; never block Pi startup on it.
  }
}

function refreshCache(): DroidCache | null {
  const path = droidPath();
  try {
    const version = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 5000 }).trim() || FALLBACK_DROID_VERSION;
    const execHelp = execFileSync(path, ["exec", "--help"], { encoding: "utf8", timeout: 10_000 });
    const cache = { binaryPath: path, binaryMtimeMs: binaryMtimeMs(path), version, execHelp };
    writeCache(cache);
    return cache;
  } catch {
    return null;
  }
}

function getCache() {
  // Do not shell out to Droid during normal Pi startup/reload. It adds seconds.
  // Refresh explicitly with FACTORY_DROID_REFRESH=1 pi --list-models, then /reload.
  if (process.env.FACTORY_DROID_REFRESH === "1") return refreshCache() || readCache();
  return readCache();
}

export function droidVersion() {
  return getCache()?.version || FALLBACK_DROID_VERSION;
}

export function droidExecHelp() {
  return getCache()?.execHelp || "";
}
