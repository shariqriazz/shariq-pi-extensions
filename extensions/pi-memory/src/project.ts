import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ProjectIdentity } from "./types.ts";

function runGit(cwd: string, args: string[], preserveWhitespace = false): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).replace(/\r?\n$/, "");
    const normalized = preserveWhitespace ? output : output.trim();
    return normalized || undefined;
  } catch {
    return undefined;
  }
}

export function normalizeRemoteUrl(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.git$/i, "").replace(/\/$/, "");
  if (!trimmed) return undefined;

  const scp = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+/, "")}`;

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/^\/+/, "");
    if (!url.hostname || !pathname) return undefined;
    return `${url.hostname.toLowerCase()}/${pathname}`;
  } catch {
    return undefined;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "workspace";
}

export function resolveProject(cwd: string): ProjectIdentity {
  const canonicalCwd = fs.realpathSync.native(cwd);
  const gitRoot = runGit(canonicalCwd, ["rev-parse", "--show-toplevel"], true);
  const canonicalRoot = gitRoot && fs.existsSync(gitRoot) ? fs.realpathSync.native(gitRoot) : canonicalCwd;
  const remote = gitRoot ? runGit(canonicalRoot, ["config", "--get", "remote.origin.url"]) : undefined;
  const normalizedRemote = remote ? normalizeRemoteUrl(remote) : undefined;
  const identity = normalizedRemote ? `git:${normalizedRemote}` : `path:${canonicalRoot}`;
  const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const displayName = path.basename(canonicalRoot) || "workspace";
  return {
    id: hash,
    identity,
    rootPath: canonicalRoot,
    displayName,
    directoryName: `${slugify(displayName)}-${hash.slice(0, 8)}`,
  };
}

export function isEphemeralProject(project: ProjectIdentity): boolean {
  const roots = [os.tmpdir()];
  if (process.platform !== "win32") roots.push("/tmp", "/private/tmp", "/var/tmp");
  return roots.some((temporaryRoot) => {
    let canonicalTemporaryRoot: string;
    try {
      canonicalTemporaryRoot = fs.realpathSync.native(temporaryRoot);
    } catch {
      canonicalTemporaryRoot = path.resolve(temporaryRoot);
    }
    const relative = path.relative(canonicalTemporaryRoot, path.resolve(project.rootPath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
