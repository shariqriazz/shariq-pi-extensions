import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const errors = [];

for (const entry of manifest.pi?.extensions ?? []) {
  const target = resolve(root, entry);
  if (!existsSync(target) || !statSync(target).isFile()) {
    errors.push(`Missing extension entrypoint: ${entry}`);
  }
}
for (const entry of manifest.pi?.skills ?? []) {
  const target = resolve(root, entry, "SKILL.md");
  if (!existsSync(target) || !statSync(target).isFile()) {
    errors.push(`Missing skill entrypoint: ${entry}`);
  }
}

const forbiddenNames = new Set([
  ".env",
  "auth.json",
  "factory-api-keys.json",
  "api-keys.json",
  "memory.sqlite",
]);

function walk(directory) {
  for (const name of readdirSync(directory)) {
    if (name === ".git" || name === "node_modules") continue;
    const target = join(directory, name);
    const stat = statSync(target);
    if (stat.isDirectory()) {
      walk(target);
      continue;
    }
    if (forbiddenNames.has(name) || name.endsWith(".sqlite-wal") || name.endsWith(".sqlite-shm")) {
      errors.push(`Forbidden runtime or secret file: ${relative(root, target)}`);
    }
  }
}

walk(root);

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Validated ${manifest.pi.extensions.length} extensions and ${manifest.pi.skills.length} skills; no runtime secrets or databases found.`);
}
