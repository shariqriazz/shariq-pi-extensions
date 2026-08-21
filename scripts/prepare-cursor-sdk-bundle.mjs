import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const connectPackagePath = join(
  process.cwd(),
  "node_modules",
  "@connectrpc",
  "connect-node",
  "package.json",
);
const connectPackage = JSON.parse(await readFile(connectPackagePath, "utf8"));
if (connectPackage.version !== "1.7.0") {
  throw new Error(`Expected @connectrpc/connect-node 1.7.0, found ${connectPackage.version ?? "unknown"}.`);
}
const installedRange = connectPackage.dependencies?.undici;
if (installedRange !== "^5.28.4" && installedRange !== "6.28.0") {
  throw new Error(`Unexpected @connectrpc/connect-node Undici range: ${installedRange ?? "missing"}.`);
}
connectPackage.dependencies.undici = "6.28.0";
await writeFile(connectPackagePath, `${JSON.stringify(connectPackage, null, 2)}\n`);
