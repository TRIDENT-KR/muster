import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adoptProject } from "../src/adopt.js";
import { checkProject, syncProject } from "../src/commands.js";

const TMP_ROOT = path.join(process.cwd(), ".tmp");
let testRoot: string;

function makeRepo(name: string): string {
  const dir = path.join(testRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function write(base: string, rel: string, content: string): void {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  testRoot = fs.mkdtempSync(path.join(TMP_ROOT, "adopt-"));
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("muster adopt", () => {
  it("adopts a scattered repo end to end without duplicating content", () => {
    const repo = makeRepo("full");
    write(repo, "AGENTS.md", "# Org rules\n\nAlways be testing.");
    write(repo, "CLAUDE.md", "@AGENTS.md\n"); // bridge — carries no content
    write(repo, ".cursorrules", "Prefer functional style.");
    write(repo, ".claude/skills/deploy/SKILL.md", "---\nname: deploy\n---\n\nShip it.");
    write(
      repo,
      ".mcp.json",
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
          },
        },
      })
    );
    write(
      repo,
      ".cursor/mcp.json",
      JSON.stringify({
        mcpServers: {
          context7: { url: "https://mcp.context7.com/mcp", headers: { "X-Key": "${env:CTX_KEY}" } },
        },
      })
    );

    const report = adoptProject(repo);

    // Secrets are replaced, never copied.
    expect(report.secretsReplaced).toEqual([
      { server: "github", field: "env.GITHUB_TOKEN", ref: "${GITHUB_TOKEN}" },
    ]);
    const serversYaml = fs.readFileSync(path.join(repo, "agent-config/mcp/servers.yaml"), "utf8");
    expect(serversYaml).not.toContain("ghp_");
    expect(serversYaml).toContain("${GITHUB_TOKEN}");
    // Cursor ${env:X} refs are canonicalized back to ${X}.
    expect(serversYaml).toContain("${CTX_KEY}");
    expect(serversYaml).not.toContain("env:CTX_KEY");

    expect(report.targets).toEqual(expect.arrayContaining(["claude-code", "cursor"]));

    syncProject(repo);
    const agents = fs.readFileSync(path.join(repo, "AGENTS.md"), "utf8");
    expect(agents).toContain("muster:begin");
    // Content appears exactly once — no duplication from the pre-existing file.
    expect(agents.split("Always be testing.").length).toBe(2);
    expect(agents).toContain("Prefer functional style.");
    expect(fs.readFileSync(path.join(repo, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    expect(fs.existsSync(path.join(repo, ".cursorrules"))).toBe(false);

    // Round-trip: cursor rendering restores ${env:X}.
    const cursorMcp = JSON.parse(fs.readFileSync(path.join(repo, ".cursor/mcp.json"), "utf8"));
    expect(cursorMcp.mcpServers.context7.headers["X-Key"]).toBe("${env:CTX_KEY}");

    expect(checkProject(repo).drift).toEqual([]);
    expect(syncProject(repo).actions.every((a) => a.action === "unchanged")).toBe(true);
  });

  it("reports a differing copilot file instead of merging it", () => {
    const repo = makeRepo("copilot-diff");
    write(repo, "AGENTS.md", "# Rules");
    write(repo, ".github/copilot-instructions.md", "# Different legacy rules");
    const report = adoptProject(repo, { dryRun: true });
    expect(report.targets).not.toContain("copilot");
    expect(report.notes.join(" ")).toMatch(/copilot-instructions\.md differs/);
  });

  it("captures an identical copilot file and enables the target", () => {
    const repo = makeRepo("copilot-same");
    write(repo, "AGENTS.md", "# Same rules\n");
    write(repo, ".github/copilot-instructions.md", "# Same rules\n");
    const report = adoptProject(repo);
    expect(report.targets).toContain("copilot");
    expect(fs.existsSync(path.join(repo, ".github/copilot-instructions.md"))).toBe(false);
    syncProject(repo);
    const rendered = fs.readFileSync(path.join(repo, ".github/copilot-instructions.md"), "utf8");
    expect(rendered).toContain("# Same rules");
    expect(rendered).toContain("muster:begin");
  });

  it("dry run writes nothing", () => {
    const repo = makeRepo("dry");
    write(repo, "AGENTS.md", "# Rules");
    const report = adoptProject(repo, { dryRun: true });
    expect(report.fragments.length).toBe(1);
    expect(fs.existsSync(path.join(repo, "agent-config"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "muster.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "AGENTS.md"))).toBe(true);
  });

  it("refuses an empty repo and an already-initialized repo", () => {
    const empty = makeRepo("empty");
    expect(() => adoptProject(empty)).toThrow(/nothing to adopt/);
    const done = makeRepo("done");
    write(done, "muster.yaml", "version: 1\n");
    expect(() => adoptProject(done)).toThrow(/already/);
  });
});

describe("gemini-cli target", () => {
  it("renders GEMINI.md with the full instruction body", () => {
    const src = makeRepo("gem-src");
    write(src, "instructions/00-org.md", "# G Org\n\nRule.");
    const app = makeRepo("gem-app");
    write(
      app,
      "muster.yaml",
      ["version: 1", `source: ${JSON.stringify(src)}`, "targets: [gemini-cli]", ""].join("\n")
    );
    syncProject(app);
    const gemini = fs.readFileSync(path.join(app, "GEMINI.md"), "utf8");
    expect(gemini).toContain("# G Org");
    expect(gemini).toContain("muster:begin");
    expect(checkProject(app).drift).toEqual([]);
  });
});
