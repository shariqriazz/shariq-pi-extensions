import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const errors = [];
const extensionEntries = manifest.pi?.extensions ?? [];
const normalizedExtensionEntries = extensionEntries.map((entry) => entry.replace(/^\.\//, ""));

if (new Set(normalizedExtensionEntries).size !== normalizedExtensionEntries.length) {
  errors.push("Duplicate extension entrypoint in package.json#pi.extensions");
}
if (normalizedExtensionEntries.join("\n") !== [...normalizedExtensionEntries].sort().join("\n")) {
  errors.push("package.json#pi.extensions must remain alphabetically sorted");
}
if (manifest.workspaces !== undefined) {
  errors.push("The suite must remain one root package; remove nested workspaces");
}

for (const entry of extensionEntries) {
  const target = resolve(root, entry);
  if (!existsSync(target) || !statSync(target).isFile()) {
    errors.push(`Missing extension entrypoint: ${entry}`);
    continue;
  }
  if (!/^extensions\/[^/]+\/index\.[cm]?[jt]s$/.test(entry.replace(/^\.\//, ""))) {
    errors.push(`Extension entrypoint must use extensions/<name>/index.ts: ${entry}`);
  }
  const readme = join(dirname(target), "README.md");
  if (!existsSync(readme) || !statSync(readme).isFile()) {
    errors.push(`Missing extension README: ${relative(root, readme)}`);
  }
}

const declaredExtensions = new Set(normalizedExtensionEntries);
for (const name of readdirSync(join(root, "extensions"))) {
  const directory = join(root, "extensions", name);
  if (!statSync(directory).isDirectory()) continue;
  if (!existsSync(join(directory, "README.md"))) {
    errors.push(`Missing directory README: extensions/${name}/README.md`);
  }
  if (name === "shared") continue;
  const entry = join(directory, "index.ts");
  if (existsSync(entry) && !declaredExtensions.has(relative(root, entry))) {
    errors.push(`Undeclared extension entrypoint: ${relative(root, entry)}`);
  }
  if (existsSync(join(directory, "package.json"))) {
    errors.push(`Nested extension package is not allowed: extensions/${name}/package.json`);
  }
  const hasTests = readdirSync(directory, { recursive: true }).some((item) => String(item).endsWith(".test.ts"));
  if (!hasTests) errors.push(`Missing extension test: extensions/${name}`);
}
if (manifest.scripts?.test !== "node scripts/run-tests.mjs") {
  errors.push("npm test must use the recursive extension test runner");
}

const skillEntries = manifest.pi?.skills ?? [];
const normalizedSkillEntries = skillEntries.map((entry) => entry.replace(/^\.\//, ""));
if (new Set(normalizedSkillEntries).size !== normalizedSkillEntries.length) {
  errors.push("Duplicate skill entrypoint in package.json#pi.skills");
}
if (normalizedSkillEntries.join("\n") !== [...normalizedSkillEntries].sort().join("\n")) {
  errors.push("package.json#pi.skills must remain alphabetically sorted");
}
for (const entry of skillEntries) {
  const normalized = entry.replace(/^\.\//, "");
  if (!/^skills\/[^/]+$/.test(normalized)) {
    errors.push(`Skill entrypoint must use skills/<name>: ${entry}`);
  }
  const target = resolve(root, entry, "SKILL.md");
  if (!existsSync(target) || !statSync(target).isFile()) {
    errors.push(`Missing skill entrypoint: ${entry}`);
  }
}
const declaredSkills = new Set(normalizedSkillEntries);
for (const name of readdirSync(join(root, "skills"))) {
  const directory = join(root, "skills", name);
  if (!statSync(directory).isDirectory()) continue;
  const skillFile = join(directory, "SKILL.md");
  if (existsSync(skillFile) && !declaredSkills.has(relative(root, directory))) {
    errors.push(`Undeclared skill entrypoint: ${relative(root, directory)}`);
  }
}

const forbiddenExactNames = new Set([
  ".env",
  "auth.json",
  "factory-api-keys.json",
  "api-keys.json",
  "credentials.json",
]);
const forbiddenDirectories = new Set([".cache", "cache", "logs", "sessions", "tmp"]);
function forbiddenPackPath(filename) {
  const normalized = filename.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const base = parts.at(-1)?.toLowerCase() ?? "";
  if (parts.some((part) => forbiddenDirectories.has(part.toLowerCase()))) return true;
  if (forbiddenExactNames.has(base) || base.startsWith(".env.")) return true;
  return /\.(?:sqlite|sqlite-wal|sqlite-shm|db|db-wal|db-shm|log|jsonl)$/i.test(base);
}

try {
  const packJson = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pack = JSON.parse(packJson)?.[0];
  const packedFiles = Array.isArray(pack?.files) ? pack.files.map((file) => file.path) : [];
  if (packedFiles.length === 0) errors.push("npm pack returned no files");
  for (const filename of packedFiles) {
    if (forbiddenPackPath(filename)) errors.push(`Forbidden runtime or secret file in package: ${filename}`);
  }
  for (const entry of [...extensionEntries, ...skillEntries.map((entry) => `${entry}/SKILL.md`)]) {
    const normalized = entry.replace(/^\.\//, "");
    if (!packedFiles.includes(normalized)) errors.push(`Declared resource missing from package payload: ${normalized}`);
  }
  if (packedFiles.some((filename) => filename.endsWith(".test.ts"))) {
    errors.push("Test files must not be included in the package payload");
  }
} catch (error) {
  errors.push(`Could not inspect npm package payload: ${error instanceof Error ? error.message : String(error)}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Validated ${manifest.pi.extensions.length} extensions, ${manifest.pi.skills.length} skills, recursive tests, and the npm payload; no forbidden runtime state or secret files were packed.`);
}
