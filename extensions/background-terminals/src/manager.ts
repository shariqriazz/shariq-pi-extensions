import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn as spawnPty, type IDisposable, type IPty } from "@lydell/node-pty";
import { OutputBuffer } from "./output-buffer.ts";
import type {
  StartTerminalOptions,
  TerminalReadResult,
  TerminalSnapshot,
  TerminalStatus,
} from "./types.ts";

export const MAX_RUNNING_TERMINALS = 8;
export const MAX_TRACKED_TERMINALS = 32;
export const RETAINED_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_FULL_LOG_BYTES = 64 * 1024 * 1024;
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 750;
const FLUSH_GRACE_MS = 1_000;

interface MutableSnapshot {
  id: string;
  title: string;
  command: string;
  cwd: string;
  pid: number;
  status: TerminalStatus;
  createdAt: number;
  settledAt?: number;
  exitCode?: number;
  signal?: number;
  errorText?: string;
  readonly output: ReturnType<OutputBuffer["view"]>;
  cols: number;
  rows: number;
}

interface Entry {
  readonly snapshot: MutableSnapshot;
  readonly pty: IPty;
  readonly output: OutputBuffer;
  readonly spill: fs.WriteStream;
  readonly dataSubscription: IDisposable;
  readonly exitSubscription: IDisposable;
  readonly settled: Promise<TerminalSnapshot>;
  resolveSettled(snapshot: TerminalSnapshot): void;
  killRequested: boolean;
  settling: boolean;
  settledFinal: boolean;
}

export interface TerminalManagerView {
  list(): ReadonlyArray<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  subscribe(listener: () => void): () => void;
  subscribeTo(id: string, listener: () => void): () => void;
  requestKill(id: string): void;
  requestWrite(id: string, input: string): void;
  requestResize(id: string, cols: number, rows: number): void;
}

function asSnapshot(snapshot: MutableSnapshot): TerminalSnapshot {
  return snapshot;
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function shellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
    };
  }
  const configured = process.env.SHELL;
  const file = configured && path.isAbsolute(configured) && fs.existsSync(configured)
    ? configured
    : "/bin/sh";
  return { file, args: ["-c", command] };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly idListeners = new Map<string, Set<() => void>>();
  private readonly spillDir: string;
  private counter = 0;
  private starting = 0;
  private disposed = false;
  private settledListener?: (snapshot: TerminalSnapshot) => void;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly maxFullLogBytes: number;

  readonly view: TerminalManagerView;

  constructor(
    environment: NodeJS.ProcessEnv = process.env,
    options: { maxFullLogBytes?: number } = {},
  ) {
    this.environment = environment;
    this.maxFullLogBytes = Math.max(1, options.maxFullLogBytes ?? MAX_FULL_LOG_BYTES);
    const base = path.join(os.tmpdir(), "pi-background-terminals");
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    fs.chmodSync(base, 0o700);
    this.spillDir = fs.mkdtempSync(path.join(base, "session-"));
    fs.chmodSync(this.spillDir, 0o700);
    this.view = {
      list: () => this.list(),
      get: (id) => this.get(id),
      subscribe: (listener) => this.subscribe(listener),
      subscribeTo: (id, listener) => this.subscribeTo(id, listener),
      requestKill: (id) => {
        void this.kill([id]);
      },
      requestWrite: (id, input) => {
        try {
          this.write(id, input);
        } catch {
          // The detail view rerenders the settled/error state.
        }
      },
      requestResize: (id, cols, rows) => {
        try {
          this.resize(id, cols, rows);
        } catch {
          // Resize races with process exit are harmless.
        }
      },
    };
  }

  setOnSettled(listener: ((snapshot: TerminalSnapshot) => void) | undefined): void {
    this.settledListener = listener;
  }

  list(): ReadonlyArray<TerminalSnapshot> {
    return [...this.entries.values()]
      .map((entry) => asSnapshot(entry.snapshot))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  get(id: string): TerminalSnapshot | undefined {
    return this.entries.get(id)?.snapshot;
  }

  private notify(id?: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // UI observers cannot own process lifecycle.
      }
    }
    if (!id) return;
    for (const listener of [...(this.idListeners.get(id) ?? [])]) {
      try {
        listener();
      } catch {
        // Same isolation for detail observers.
      }
    }
  }

  private subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private subscribeTo(id: string, listener: () => void): () => void {
    const listeners = this.idListeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    this.idListeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.idListeners.delete(id);
    };
  }

  start(options: StartTerminalOptions): TerminalSnapshot {
    if (this.disposed) throw new Error("Background terminal manager is shutting down.");
    const running = this.list().filter((snapshot) => snapshot.status === "running").length;
    if (running + this.starting >= MAX_RUNNING_TERMINALS) {
      throw new Error(`At most ${MAX_RUNNING_TERMINALS} background terminals can run at once.`);
    }
    this.starting++;
    try {
      const id = `term-${++this.counter}`;
      const cols = Math.min(500, Math.max(20, options.cols ?? 120));
      const rows = Math.min(200, Math.max(8, options.rows ?? 30));
      const spillPath = path.join(this.spillDir, `${id}.log`);
      const spill = fs.createWriteStream(spillPath, { flags: "a", mode: 0o600 });
      let spillHealthy = true;
      let spillBytes = 0;
      let spillTruncated = false;
      let pausedForSpill = false;
      let pty: IPty | undefined;
      let snapshot: MutableSnapshot | undefined;
      const markSpillTruncated = () => {
        if (spillTruncated) return;
        spillTruncated = true;
        output.spillTruncated = true;
      };
      const output = new OutputBuffer(RETAINED_OUTPUT_BYTES, (chunk) => {
        if (!spillHealthy || spill.writableEnded || spillTruncated) return;
        const bytes = Buffer.from(chunk, "utf8");
        const remaining = this.maxFullLogBytes - spillBytes;
        if (remaining <= 0) {
          markSpillTruncated();
          return;
        }
        const payload = bytes.length > remaining ? bytes.subarray(0, remaining) : bytes;
        spillBytes += payload.length;
        const accepted = spill.write(payload);
        if (payload.length < bytes.length || spillBytes >= this.maxFullLogBytes) markSpillTruncated();
        if (!accepted && pty && !pausedForSpill) {
          pausedForSpill = true;
          pty.pause();
        }
      });
      output.spillPath = spillPath;
      spill.on("drain", () => {
        if (!pausedForSpill) return;
        pausedForSpill = false;
        try {
          pty?.resume();
        } catch {
          // Exit may have won the drain race.
        }
      });
      spill.on("error", (error) => {
        spillHealthy = false;
        output.spillPath = undefined;
        if (pausedForSpill) {
          pausedForSpill = false;
          try {
            pty?.resume();
          } catch {
            // Exit may have won the error race.
          }
        }
        const entry = this.entries.get(id);
        if (entry) entry.snapshot.errorText ??= `Full-log capture failed: ${cleanError(error)}`;
      });

      const shell = shellInvocation(options.command);
      try {
        pty = spawnPty(shell.file, shell.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: options.cwd,
          env: { ...this.environment, TERM: "xterm-256color" },
        });
      } catch (error) {
        spill.end();
        throw new Error(`Failed to start background terminal: ${cleanError(error)}`);
      }

      let resolveSettled!: (snapshot: TerminalSnapshot) => void;
      const settled = new Promise<TerminalSnapshot>((resolve) => {
        resolveSettled = resolve;
      });
      snapshot = {
        id,
        title: options.title,
        command: options.command,
        cwd: options.cwd,
        pid: pty.pid,
        status: "running",
        createdAt: Date.now(),
        cols,
        rows,
        get output() {
          return output.view();
        },
      };
      const activePty = pty!;
      const activeSnapshot = snapshot!;
      const entry = {} as Entry;
      const dataSubscription = activePty.onData((chunk) => {
        if (entry.settledFinal) return;
        output.push(chunk);
        this.notify(id);
      });
      const exitSubscription = activePty.onExit(({ exitCode, signal }) => {
        void this.finalize(entry, exitCode, signal);
      });
      Object.assign(entry, {
        snapshot: activeSnapshot,
        pty: activePty,
        output,
        spill,
        dataSubscription,
        exitSubscription,
        settled,
        resolveSettled,
        killRequested: false,
        settling: false,
        settledFinal: false,
      } satisfies Entry);
      this.entries.set(id, entry);
      this.notify(id);
      return activeSnapshot;
    } finally {
      this.starting--;
    }
  }

  private async finalize(entry: Entry, exitCode: number, signal?: number): Promise<void> {
    if (entry.settledFinal || entry.settling) return;
    entry.settling = true;
    let flushed = entry.spill.writableFinished;
    await Promise.race([
      new Promise<void>((resolve) => {
        if (flushed) {
          resolve();
          return;
        }
        entry.spill.end(() => {
          flushed = true;
          resolve();
        });
      }),
      wait(FLUSH_GRACE_MS),
    ]);
    if (!flushed) {
      entry.snapshot.errorText ??= "Full-log flush timed out; the spill file may be incomplete.";
      entry.output.spillPath = undefined;
      entry.spill.destroy();
    }
    if (entry.settledFinal) return;
    entry.settledFinal = true;
    entry.snapshot.exitCode = exitCode;
    entry.snapshot.signal = signal || undefined;
    entry.snapshot.status = entry.killRequested
      ? "killed"
      : exitCode === 0
        ? "done"
        : "failed";
    entry.snapshot.settledAt = Date.now();
    entry.dataSubscription.dispose();
    entry.exitSubscription.dispose();
    entry.resolveSettled(entry.snapshot);
    this.notify(entry.snapshot.id);
    if (!this.disposed) this.settledListener?.(entry.snapshot);
    this.prune();
  }

  private signal(entry: Entry, signal: "SIGTERM" | "SIGKILL"): void {
    if (process.platform !== "win32") {
      try {
        process.kill(-entry.snapshot.pid, signal);
        return;
      } catch {
        // node-pty still knows how to terminate its direct child.
      }
    }
    try {
      entry.pty.kill(signal);
    } catch {
      // Exit may have won the race.
    }
  }

  async kill(ids: ReadonlyArray<string>): Promise<ReadonlyArray<TerminalSnapshot>> {
    const unique = [...new Set(ids)];
    const entries = unique.map((id) => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown background terminal "${id}".`);
      return entry;
    });
    await Promise.all(entries.map(async (entry) => {
      if (entry.snapshot.status !== "running") return;
      entry.killRequested = true;
      this.signal(entry, "SIGTERM");
      await Promise.race([entry.settled, wait(TERM_GRACE_MS)]);
      if (entry.snapshot.status !== "running") return;
      this.signal(entry, "SIGKILL");
      await Promise.race([entry.settled, wait(KILL_GRACE_MS)]);
      if (entry.snapshot.status === "running") {
        entry.snapshot.errorText ??= "Process exit was not observed after SIGKILL; output may be incomplete.";
        await this.finalize(entry, 137, 9);
      }
    }));
    return entries.map((entry) => entry.snapshot);
  }

  write(id: string, input: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown background terminal "${id}".`);
    if (entry.snapshot.status !== "running") throw new Error(`Background terminal ${id} is ${entry.snapshot.status}.`);
    if (Buffer.byteLength(input, "utf8") > 64 * 1024) throw new Error("Terminal input is limited to 64KB per write.");
    entry.pty.write(input);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id);
    if (!entry || entry.snapshot.status !== "running") return;
    const nextCols = Math.min(500, Math.max(20, Math.floor(cols)));
    const nextRows = Math.min(200, Math.max(8, Math.floor(rows)));
    if (nextCols === entry.snapshot.cols && nextRows === entry.snapshot.rows) return;
    entry.snapshot.cols = nextCols;
    entry.snapshot.rows = nextRows;
    entry.pty.resize(nextCols, nextRows);
  }

  async read(
    id: string,
    options: { cursor?: number; waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<TerminalReadResult> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown background terminal "${id}".`);
    const cursor = options.cursor;
    if (
      options.waitMs &&
      options.waitMs > 0 &&
      entry.snapshot.status === "running" &&
      cursor === entry.output.totalBytes
    ) {
      await this.waitForChange(id, Math.min(10_000, options.waitMs), options.signal);
    }
    const result = entry.output.readSince(cursor);
    return { snapshot: entry.snapshot, ...result };
  }

  private waitForChange(id: string, waitMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Terminal read aborted."));
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const unsubscribe = this.subscribeTo(id, () => finish());
      const timer = setTimeout(() => finish(), waitMs);
      timer.unref?.();
      const onAbort = () => finish(new Error("Terminal read aborted."));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private prune(): void {
    if (this.entries.size <= MAX_TRACKED_TERMINALS) return;
    const settled = [...this.entries.values()]
      .filter((entry) => entry.snapshot.status !== "running")
      .sort((left, right) => (left.snapshot.settledAt ?? 0) - (right.snapshot.settledAt ?? 0));
    for (const entry of settled) {
      if (this.entries.size <= MAX_TRACKED_TERMINALS) break;
      this.entries.delete(entry.snapshot.id);
      this.idListeners.delete(entry.snapshot.id);
      fs.rmSync(entry.output.spillPath ?? entry.spill.path.toString(), { force: true });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.settledListener = undefined;
    const running = this.list().filter((snapshot) => snapshot.status === "running").map((snapshot) => snapshot.id);
    if (running.length > 0) await this.kill(running);
    this.listeners.clear();
    this.idListeners.clear();
    this.entries.clear();
    fs.rmSync(this.spillDir, { recursive: true, force: true });
  }
}
