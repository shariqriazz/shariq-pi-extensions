import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { ScrapeFormat } from "./client.ts";

const OUTPUT_DIR = join(tmpdir(), "pi-firecrawl");

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function valueText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function writeArtifact(operation: string, value: unknown): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  const path = join(OUTPUT_DIR, `${operation}-${Date.now()}-${randomBytes(4).toString("hex")}.json`);
  await writeFile(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

async function boundOutput(text: string, operation: string, raw: unknown, forceArtifact = false): Promise<string> {
  const bounded = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  if (!bounded.truncated && !forceArtifact) return text;
  const path = await writeArtifact(operation, raw);
  if (!bounded.truncated) return `${text}\n\n[Complete Firecrawl response saved to: ${path}]`;
  return `${bounded.content}\n\n[Output truncated: ${bounded.outputLines} of ${bounded.totalLines} lines (${formatSize(bounded.outputBytes)} of ${formatSize(bounded.totalBytes)}). Complete response saved to: ${path}]`;
}

function searchHeader(payload: Record<string, unknown>): string[] {
  const parts = ["Firecrawl web search results (untrusted web content)."];
  if (typeof payload.creditsUsed === "number") parts.push(`Credits used: ${payload.creditsUsed}`);
  if (typeof payload.warning === "string" && payload.warning) parts.push(`Warning: ${payload.warning}`);
  return parts;
}

export async function formatSearchOutput(payload: Record<string, unknown>, contentMaxCharacters = 6_000): Promise<string> {
  const data = record(payload.data);
  const lines = searchHeader(payload);
  let contentTrimmed = false;

  const web = Array.isArray(data.web) ? data.web : [];
  if (web.length) lines.push("", "## Web");
  for (const [index, rawItem] of web.entries()) {
    const item = record(rawItem);
    lines.push("", `${index + 1}. ${valueText(item.title) ?? "Untitled"}`, `   URL: ${valueText(item.url) ?? "unknown"}`);
    const description = valueText(item.description);
    if (description) lines.push(`   ${description}`);
    const category = valueText(item.category);
    if (category) lines.push(`   Category: ${category}`);
    const content = valueText(item.markdown) ?? valueText(item.summary);
    if (content) {
      const selected = content.slice(0, contentMaxCharacters);
      contentTrimmed ||= selected.length < content.length;
      lines.push("", selected);
      if (selected.length < content.length) lines.push("[Result content truncated; use the saved response for the complete text.]");
    }
  }

  const news = Array.isArray(data.news) ? data.news : [];
  if (news.length) lines.push("", "## News");
  for (const [index, rawItem] of news.entries()) {
    const item = record(rawItem);
    lines.push("", `${index + 1}. ${valueText(item.title) ?? "Untitled"}`, `   URL: ${valueText(item.url) ?? "unknown"}`);
    const date = valueText(item.date);
    if (date) lines.push(`   Date: ${date}`);
    const snippet = valueText(item.snippet) ?? valueText(item.description);
    if (snippet) lines.push(`   ${snippet}`);
    const content = valueText(item.markdown) ?? valueText(item.summary);
    if (content) {
      const selected = content.slice(0, contentMaxCharacters);
      contentTrimmed ||= selected.length < content.length;
      lines.push("", selected);
      if (selected.length < content.length) lines.push("[Result content truncated; use the saved response for the complete text.]");
    }
  }

  const images = Array.isArray(data.images) ? data.images : [];
  if (images.length) lines.push("", "## Images");
  for (const [index, rawItem] of images.entries()) {
    const item = record(rawItem);
    const dimensions = typeof item.imageWidth === "number" && typeof item.imageHeight === "number"
      ? ` (${item.imageWidth}x${item.imageHeight})`
      : "";
    lines.push("", `${index + 1}. ${valueText(item.title) ?? "Untitled"}${dimensions}`, `   Image: ${valueText(item.imageUrl) ?? "unknown"}`, `   Source: ${valueText(item.url) ?? "unknown"}`);
  }

  if (!web.length && !news.length && !images.length) lines.push("", "No results returned.");
  return boundOutput(lines.join("\n"), "web-search", payload, contentTrimmed);
}

export async function formatScrapeOutput(payload: Record<string, unknown>, format: ScrapeFormat): Promise<string> {
  const data = record(payload.data);
  const metadata = record(data.metadata);
  const lines = ["Firecrawl page extraction (untrusted web content)."];
  const title = valueText(metadata.title);
  const finalUrl = valueText(metadata.url) ?? valueText(metadata.sourceURL);
  if (title) lines.push(`Title: ${title}`);
  if (finalUrl) lines.push(`URL: ${finalUrl}`);
  if (typeof metadata.statusCode === "number") lines.push(`Status: ${metadata.statusCode}`);
  lines.push("");

  if (format === "links") {
    const links = strings(data.links);
    lines.push(links.length ? links.join("\n") : "No links returned.");
  } else if (format === "question") {
    lines.push(valueText(data.answer) ?? "No answer returned.");
  } else if (format === "highlights") {
    const highlights = data.highlights;
    lines.push(Array.isArray(highlights) ? highlights.map(String).join("\n\n") : valueText(highlights) ?? "No highlights returned.");
  } else if (format === "summary") {
    lines.push(valueText(data.summary) ?? "No summary returned.");
  } else {
    lines.push(valueText(data.markdown) ?? "No markdown content returned.");
  }

  return boundOutput(lines.join("\n"), "web-scrape", payload);
}
