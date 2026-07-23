import { createHash } from "node:crypto";
import type { McpServer } from "./types.js";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{16,}/, "OpenAI/Anthropic-style API key"],
  [/ghp_[A-Za-z0-9]{20,}/, "GitHub personal access token"],
  [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
];

/** Reject literal secrets in server configs — values must use ${ENV_VAR} references. */
export function assertNoSecrets(name: string, server: McpServer): void {
  const serialized = JSON.stringify(server);
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error(
        `mcp server "${name}" appears to contain a literal ${label}. ` +
          `Never commit secrets — reference an environment variable instead, e.g. "\${MY_TOKEN}".`
      );
    }
  }
}

export function validateServer(name: string, server: McpServer): void {
  const isStdio = typeof server.command === "string";
  const isHttp = typeof server.url === "string";
  if (isStdio === isHttp) {
    throw new Error(
      `mcp server "${name}" must define exactly one of "command" (stdio) or "url" (http).`
    );
  }
  assertNoSecrets(name, server);
}

/** Render an entry for Claude Code's .mcp.json (http servers carry an explicit type). */
export function toClaudeEntry(server: McpServer): Record<string, unknown> {
  if (server.command) {
    const entry: Record<string, unknown> = { command: server.command };
    if (server.args) entry.args = server.args;
    if (server.env) entry.env = server.env;
    return entry;
  }
  const entry: Record<string, unknown> = { type: "http", url: server.url };
  if (server.headers) entry.headers = server.headers;
  return entry;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Canonical configs use `${NAME}`; Cursor only interpolates `${env:NAME}`. */
function toCursorEnvRefs(value: unknown): unknown {
  if (typeof value === "string") return value.replace(ENV_REF, "${env:$1}");
  if (Array.isArray(value)) return value.map(toCursorEnvRefs);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toCursorEnvRefs(v)])
    );
  }
  return value;
}

/** Render an entry for Cursor's .cursor/mcp.json. */
export function toCursorEntry(server: McpServer): Record<string, unknown> {
  let entry: Record<string, unknown>;
  if (server.command) {
    entry = { command: server.command };
    if (server.args) entry.args = server.args;
    if (server.env) entry.env = server.env;
  } else {
    entry = { url: server.url };
    if (server.headers) entry.headers = server.headers;
  }
  return toCursorEnvRefs(entry) as Record<string, unknown>;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortDeep(v)])
    );
  }
  return value;
}

/** Order-independent hash of the entries muster manages inside a JSON file. */
export function entriesHash(entries: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(sortDeep(entries))).digest("hex");
}

/**
 * Merge managed entries into an existing JSON file, preserving everything else.
 * Previously managed keys that are no longer desired are removed.
 */
export function applyJsonMerge(
  existingText: string | null,
  root: string,
  entries: Record<string, unknown>,
  previouslyManaged: string[]
): string {
  let doc: Record<string, unknown> = {};
  if (existingText !== null && existingText.trim().length > 0) {
    const parsed: unknown = JSON.parse(existingText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`expected a JSON object at the top level`);
    }
    doc = parsed as Record<string, unknown>;
  }
  const existingRoot = doc[root];
  const rootObj: Record<string, unknown> =
    existingRoot && typeof existingRoot === "object" && !Array.isArray(existingRoot)
      ? { ...(existingRoot as Record<string, unknown>) }
      : {};
  for (const stale of previouslyManaged) {
    if (!(stale in entries)) delete rootObj[stale];
  }
  Object.assign(rootObj, entries);
  doc[root] = rootObj;
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Read back the currently managed entries from a JSON file for drift comparison. */
export function readManagedEntries(
  text: string,
  root: string,
  managedKeys: string[]
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rootObj = (parsed as Record<string, unknown>)[root];
  if (!rootObj || typeof rootObj !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const key of managedKeys) {
    const value = (rootObj as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
