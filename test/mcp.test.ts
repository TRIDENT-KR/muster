import { describe, expect, it } from "vitest";
import {
  applyJsonMerge,
  assertNoSecrets,
  entriesHash,
  readManagedEntries,
  toClaudeEntry,
  toCursorEntry,
  validateServer,
} from "../src/mcp.js";

const stdio = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
};
const http = { url: "https://mcp.example.dev/mcp" };

describe("entry rendering", () => {
  it("renders stdio servers identically for Claude and Cursor", () => {
    expect(toClaudeEntry(stdio)).toEqual(stdio);
    expect(toCursorEntry(stdio)).toEqual(stdio);
  });

  it("adds an explicit http type only for Claude", () => {
    expect(toClaudeEntry(http)).toEqual({ type: "http", url: http.url });
    expect(toCursorEntry(http)).toEqual({ url: http.url });
  });
});

describe("validation", () => {
  it("rejects servers with both or neither transport", () => {
    expect(() => validateServer("bad", {})).toThrow(/exactly one/);
    expect(() => validateServer("bad", { command: "x", url: "https://y" })).toThrow(/exactly one/);
  });

  it("rejects literal secrets and accepts env references", () => {
    expect(() =>
      assertNoSecrets("github", {
        command: "npx",
        env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
      })
    ).toThrow(/Never commit secrets/);
    expect(() => assertNoSecrets("github", stdio)).not.toThrow();
  });
});

describe("json merge", () => {
  it("preserves unmanaged keys and removes stale managed keys", () => {
    const existing = JSON.stringify({
      mcpServers: { personal: { command: "my-tool" }, old: { command: "gone" } },
      otherTopLevel: true,
    });
    const merged = applyJsonMerge(existing, "mcpServers", { github: toClaudeEntry(stdio) }, ["old"]);
    const parsed = JSON.parse(merged);
    expect(parsed.mcpServers.personal).toEqual({ command: "my-tool" });
    expect(parsed.mcpServers.old).toBeUndefined();
    expect(parsed.mcpServers.github.command).toBe("npx");
    expect(parsed.otherTopLevel).toBe(true);
  });

  it("round-trips managed entries for drift comparison", () => {
    const entries = { github: toClaudeEntry(stdio) };
    const text = applyJsonMerge(null, "mcpServers", entries, []);
    const readBack = readManagedEntries(text, "mcpServers", ["github"]);
    expect(readBack).not.toBeNull();
    expect(entriesHash(readBack as Record<string, unknown>)).toBe(entriesHash(entries));
  });
});
