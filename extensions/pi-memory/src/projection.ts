import fs from "node:fs";
import path from "node:path";
import type { MemoryDatabase } from "./database.ts";
import type { MemoryRecord, ProjectIdentity } from "./types.ts";

function render(title: string, memories: MemoryRecord[]): string {
  const lines = [
    `# ${title}`,
    "",
    "<!-- Generated from pi-memory's SQLite database. Use Pi memory tools to edit durable memory. -->",
    "",
  ];
  if (memories.length === 0) {
    lines.push("_No durable memories yet._", "");
    return lines.join("\n");
  }
  const groups = new Map<string, MemoryRecord[]>();
  for (const memory of memories) {
    const group = groups.get(memory.kind) ?? [];
    group.push(memory);
    groups.set(memory.kind, group);
  }
  for (const [kind, records] of groups) {
    lines.push(`## ${kind[0]!.toUpperCase()}${kind.slice(1)}`, "");
    for (const memory of records) {
      lines.push(`### ${memory.title}`, "", memory.content, "", `<!-- id:${memory.memoryId} confidence:${memory.confidence.toFixed(2)} importance:${memory.importance} -->`, "");
    }
  }
  return lines.join("\n");
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

export function writeProjections(database: MemoryDatabase, root: string): void {
  atomicWrite(path.join(root, "global", "MEMORY.md"), render("Global Memory", database.listActive("global", null)));
  const projects = database.listProjects();
  for (const project of projects) writeProjectProjection(database, root, project);

  const projectsRoot = path.join(root, "projects");
  const expected = new Set(projects.map((project) => project.directoryName));
  if (!fs.existsSync(projectsRoot)) return;
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || expected.has(entry.name)) continue;
    const projection = path.join(projectsRoot, entry.name, "MEMORY.md");
    if (!fs.existsSync(projection)) continue;
    fs.rmSync(projection);
    try { fs.rmdirSync(path.dirname(projection)); } catch {}
  }
}

export function writeProjectProjection(database: MemoryDatabase, root: string, project: ProjectIdentity): void {
  const memories = database.listActive("project", project.id);
  atomicWrite(path.join(root, "projects", project.directoryName, "MEMORY.md"), render(`Project Memory — ${project.displayName}`, memories));
}
