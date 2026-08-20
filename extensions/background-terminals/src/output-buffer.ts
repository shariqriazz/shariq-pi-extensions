import type { TerminalOutputView } from "./types.ts";

interface Chunk {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export class OutputBuffer {
  private chunks: Chunk[] = [];
  private retainedBytes = 0;
  private cachedText = "";
  private cacheValid = true;
  private _totalBytes = 0;
  private _truncatedBytes = 0;
  private _version = 0;
  spillPath?: string;
  private readonly maxRetainedBytes: number;
  private readonly spill?: (chunk: string) => void;

  constructor(maxRetainedBytes: number, spill?: (chunk: string) => void) {
    this.maxRetainedBytes = maxRetainedBytes;
    this.spill = spill;
  }

  get totalBytes(): number {
    return this._totalBytes;
  }

  push(text: string): void {
    if (!text) return;
    this.spill?.(text);
    const bytes = Buffer.byteLength(text, "utf8");
    const chunk: Chunk = {
      start: this._totalBytes,
      end: this._totalBytes + bytes,
      text,
    };
    this._totalBytes += bytes;
    this._version++;

    if (bytes >= this.maxRetainedBytes) {
      const raw = Buffer.from(text, "utf8");
      let start = Math.max(0, raw.length - this.maxRetainedBytes);
      while (start < raw.length && (raw[start]! & 0xc0) === 0x80) start++;
      const retained = raw.subarray(start).toString("utf8");
      this.chunks = [{
        start: chunk.end - Buffer.byteLength(retained, "utf8"),
        end: chunk.end,
        text: retained,
      }];
      this.retainedBytes = Buffer.byteLength(retained, "utf8");
      this._truncatedBytes = this._totalBytes - this.retainedBytes;
      this.cacheValid = false;
      return;
    }

    this.chunks.push(chunk);
    this.retainedBytes += bytes;
    while (this.retainedBytes > this.maxRetainedBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (!removed) break;
      this.retainedBytes -= removed.end - removed.start;
      this._truncatedBytes = removed.end;
    }
    this.cacheValid = false;
  }

  readSince(cursor: number | undefined): {
    text: string;
    cursor: number;
    omittedBytes: number;
  } {
    const requested = Number.isSafeInteger(cursor) && (cursor ?? 0) >= 0
      ? Math.min(cursor!, this._totalBytes)
      : Math.max(0, this._totalBytes - this.retainedBytes);
    const firstAvailable = this.chunks[0]?.start ?? this._totalBytes;
    const effective = Math.max(requested, firstAvailable);
    const omittedBytes = Math.max(0, firstAvailable - requested);
    const text = this.chunks
      .filter((chunk) => chunk.end > effective)
      .map((chunk) => {
        if (chunk.start >= effective) return chunk.text;
        const skip = effective - chunk.start;
        const raw = Buffer.from(chunk.text, "utf8");
        let offset = Math.min(skip, raw.length);
        while (offset < raw.length && (raw[offset]! & 0xc0) === 0x80) offset++;
        return raw.subarray(offset).toString("utf8");
      })
      .join("");
    return { text, cursor: this._totalBytes, omittedBytes };
  }

  view(): TerminalOutputView {
    if (!this.cacheValid) {
      this.cachedText = this.chunks.map((chunk) => chunk.text).join("");
      this.cacheValid = true;
    }
    return {
      text: this.cachedText,
      totalBytes: this._totalBytes,
      truncatedBytes: this._truncatedBytes,
      cursor: this._totalBytes,
      version: this._version,
      spillPath: this.spillPath,
    };
  }
}
