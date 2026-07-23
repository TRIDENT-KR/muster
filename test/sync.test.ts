import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProject, statusProject, syncProject } from "../src/commands.js";

const TMP_ROOT = path.join(process.cwd(), ".tmp");
let sourceDir: string;
let targetDir: string;

function write(base: string, rel: string, content: string): void {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP_ROOT, "sync-"));
  sourceDir = path.join(root, "acme-agent-config");
  targetDir = path.join(root, "demo-app");

  write(sourceDir, "instructions/00-org.md", "# Acme engineering\n\nAlways write tests.");
  write(sourceDir, "instructions/20-typescript.md", "## TypeScript\n\nUse strict mode.");
  write(sourceDir, "skills/release-notes/SKILL.md", "---\nname: release-notes\n---\n\nDraft notes.");
  write(
    sourceDir,
    "mcp/servers.yaml",
    [
      "servers:",
      "  github:",
      "    command: npx",
      '    args: ["-y", "@modelcontextprotocol/server-github"]',
      "    env:",
      '      GITHUB_TOKEN: "${GITHUB_TOKEN}"',
      "  context7:",
      '    url: "https://mcp.context7.com/mcp"',
      "",
    ].join("\n")
  );

  write(targetDir, "AGENTS.md", "# Demo-app local notes\n\nKeep this section.");
  write(
    targetDir,
    "muster.yaml",
    [
      "version: 1",
      `source: ${JSON.stringify(sourceDir)}`,
      "targets: [claude-code, cursor, copilot]",
      "",
    ].join("\n")
  );
});

afterAll(() => {
  fs.rmSync(path.join(TMP_ROOT), { recursive: true, force: true });
});

describe("sync -> check lifecycle", () => {
  it("renders all targets and preserves local AGENTS.md content", () => {
    const report = syncProject(targetDir);
    const paths = report.actions.map((a) => a.path).sort();
    expect(paths).toContain("AGENTS.md");
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".mcp.json");
    expect(paths).toContain(".cursor/mcp.json");
    expect(paths).toContain(".github/copilot-instructions.md");
    expect(paths).toContain(".claude/skills/release-notes/SKILL.md");

    const agents = fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("Always write tests.");
    expect(agents).toContain("Use strict mode.");
    expect(agents).toContain("Keep this section.");
    expect(agents.indexOf("Always write tests.")).toBeLessThan(agents.indexOf("Keep this section."));

    expect(fs.readFileSync(path.join(targetDir, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");

    const mcp = JSON.parse(fs.readFileSync(path.join(targetDir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.github.command).toBe("npx");
    expect(mcp.mcpServers.context7.type).toBe("http");
    const cursorMcp = JSON.parse(fs.readFileSync(path.join(targetDir, ".cursor/mcp.json"), "utf8"));
    expect(cursorMcp.mcpServers.context7.type).toBeUndefined();
  });

  it("is clean and idempotent right after sync", () => {
    const check = checkProject(targetDir);
    expect(check.drift).toEqual([]);
    expect(check.outdated).toEqual([]);

    const again = syncProject(targetDir);
    expect(again.actions.every((a) => a.action === "unchanged")).toBe(true);
  });

  it("detects drift when a managed region is hand-edited, and sync repairs it", () => {
    const agentsPath = path.join(targetDir, "AGENTS.md");
    const tampered = fs
      .readFileSync(agentsPath, "utf8")
      .replace("Always write tests.", "Never write tests.");
    fs.writeFileSync(agentsPath, tampered);

    const check = checkProject(targetDir);
    expect(check.drift.map((d) => d.path)).toEqual(["AGENTS.md"]);
    expect(check.drift[0]?.reason).toBe("modified");

    syncProject(targetDir);
    expect(checkProject(targetDir).drift).toEqual([]);
    expect(fs.readFileSync(agentsPath, "utf8")).toContain("Always write tests.");
  });

  it("reports outdated (not drift) when the source changes", () => {
    fs.appendFileSync(path.join(sourceDir, "instructions/00-org.md"), "\n\nShip small PRs.");
    const check = checkProject(targetDir);
    expect(check.drift).toEqual([]);
    const outdatedPaths = check.outdated.map((o) => o.path).sort();
    expect(outdatedPaths).toContain("AGENTS.md");
    expect(outdatedPaths).toContain(".github/copilot-instructions.md");

    const status = statusProject(targetDir);
    expect(status.artifacts.find((a) => a.path === "AGENTS.md")?.state).toBe("outdated");

    syncProject(targetDir);
    expect(checkProject(targetDir).outdated).toEqual([]);
  });

  it("prunes files for skills removed from the source", () => {
    const skillFile = path.join(targetDir, ".claude/skills/release-notes/SKILL.md");
    expect(fs.existsSync(skillFile)).toBe(true);

    fs.rmSync(path.join(sourceDir, "skills/release-notes"), { recursive: true });
    const report = syncProject(targetDir);
    expect(
      report.actions.find((a) => a.path === ".claude/skills/release-notes/SKILL.md")?.action
    ).toBe("delete");
    expect(fs.existsSync(skillFile)).toBe(false);
    expect(checkProject(targetDir).drift).toEqual([]);
  });

  it("refuses to sync a source containing literal secrets", () => {
    write(
      sourceDir,
      "mcp/servers.yaml",
      [
        "servers:",
        "  leaky:",
        "    command: npx",
        "    env:",
        "      TOKEN: ghp_abcdefghijklmnopqrstuvwxyz123456",
        "",
      ].join("\n")
    );
    expect(() => syncProject(targetDir)).toThrow(/Never commit secrets/);
  });
});
