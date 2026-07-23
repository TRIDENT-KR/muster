import { createHash } from "node:crypto";
import type { InstructionFragment } from "./types.js";

export const BEGIN_MARKER = "<!-- muster:begin -->";
export const END_MARKER = "<!-- muster:end -->";
const NOTICE =
  "<!-- Managed by muster. Edits inside this block will be overwritten — update the config source and run `muster sync`. -->";

export function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256")
    .update(typeof data === "string" ? normalize(data) : data)
    .digest("hex");
}

/** Compose instruction fragments in filename order into a single document. */
export function composeFragments(fragments: InstructionFragment[]): string {
  const sorted = [...fragments].sort((a, b) => a.name.localeCompare(b.name));
  return sorted
    .map((f) => normalize(f.content).trim())
    .filter((c) => c.length > 0)
    .join("\n\n");
}

export function renderManagedBlock(body: string): string {
  return `${BEGIN_MARKER}\n${NOTICE}\n\n${normalize(body).trim()}\n\n${END_MARKER}`;
}

/**
 * Insert or replace the managed block in a file. Content outside the block is
 * preserved: on first adoption of an existing file, the managed block is placed
 * on top and the original content is kept below it.
 */
export function upsertManagedBlock(existing: string | null, body: string): string {
  const block = renderManagedBlock(body);
  if (existing === null) return block + "\n";
  const text = normalize(existing);
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin !== -1 && end !== -1 && end > begin) {
    return text.slice(0, begin) + block + text.slice(end + END_MARKER.length);
  }
  const local = text.replace(/^\s+/, "");
  return local.length > 0 ? `${block}\n\n${local}` : block + "\n";
}

/** Extract the managed block (markers included), or null if absent. */
export function extractManagedBlock(text: string): string | null {
  const normalized = normalize(text);
  const begin = normalized.indexOf(BEGIN_MARKER);
  const end = normalized.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end <= begin) return null;
  return normalized.slice(begin, end + END_MARKER.length);
}

export function managedBlockHash(body: string): string {
  return sha256(renderManagedBlock(body));
}
