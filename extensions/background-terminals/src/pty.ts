import * as fs from "node:fs";
import * as path from "node:path";
import { spawn as spawnNodePty, type IDisposable, type IPty } from "@lydell/node-pty";

export interface UniversalPty {
  readonly pid: number;
  onData(listener: (chunk: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause?(): void;
  resume?(): void;
  kill(signal?: string): void;
}

export interface SpawnUniversalPtyOptions {
  file: string;
  args: string[];
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
}

declare const Bun: any;

class BunPtyAdapter implements UniversalPty {
  readonly pid: number;
  private readonly proc: any;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  private exited = false;

  constructor(options: SpawnUniversalPtyOptions) {
    const cmd = [options.file, ...options.args];
    this.proc = Bun.spawn(cmd, {
      cwd: options.cwd,
      env: options.env,
      terminal: {
        cols: options.cols,
        rows: options.rows,
        data: (_term: unknown, chunk: Uint8Array | string) => {
          const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          for (const listener of this.dataListeners) {
            try {
              listener(text);
            } catch {
              // Ignore listener errors
            }
          }
        },
      },
    });

    this.pid = this.proc.pid;

    void this.proc.exited.then((exitCode: number) => {
      if (this.exited) return;
      this.exited = true;
      const signal = this.proc.signalCode
        ? typeof this.proc.signalCode === "number"
          ? this.proc.signalCode
          : undefined
        : undefined;
      for (const listener of this.exitListeners) {
        try {
          listener({ exitCode: typeof exitCode === "number" ? exitCode : 0, signal });
        } catch {
          // Ignore listener errors
        }
      }
    });
  }

  onData(listener: (chunk: string) => void) {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
      },
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
      },
    };
  }

  write(data: string): void {
    try {
      this.proc.terminal.write(data);
    } catch {
      // Best-effort write
    }
  }

  resize(cols: number, rows: number): void {
    try {
      this.proc.terminal.resize(cols, rows);
    } catch {
      // Best-effort resize
    }
  }

  kill(signal?: string): void {
    try {
      this.proc.kill(signal ?? "SIGTERM");
    } catch {
      // Best-effort kill
    }
  }
}

class NodePtyAdapter implements UniversalPty {
  readonly pid: number;
  private readonly pty: IPty;

  constructor(pty: IPty) {
    this.pty = pty;
    this.pid = pty.pid;
  }

  onData(listener: (chunk: string) => void) {
    return this.pty.onData(listener);
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    return this.pty.onExit(listener);
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
  }

  kill(signal?: string): void {
    this.pty.kill(signal);
  }
}

export function isBunRuntime(): boolean {
  return typeof Bun !== "undefined" && typeof Bun.spawn === "function";
}

export function spawnUniversalPty(options: SpawnUniversalPtyOptions): UniversalPty {
  if (isBunRuntime()) {
    return new BunPtyAdapter(options);
  }

  const pty = spawnNodePty(options.file, options.args, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env as Record<string, string>,
  });
  return new NodePtyAdapter(pty);
}
