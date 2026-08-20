import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensions = join(root, "extensions");
const tests = [];

function discover(directory) {
  for (const name of readdirSync(directory).sort()) {
    if (name === "node_modules") continue;
    const target = join(directory, name);
    if (statSync(target).isDirectory()) discover(target);
    else if (name.endsWith(".test.ts")) tests.push(relative(root, target));
  }
}

discover(extensions);
if (tests.length === 0) {
  console.error("No extension tests found.");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", ...tests],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
