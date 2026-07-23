import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProject, syncProject } from "../src/commands.js";

const TMP_ROOT = path.join(process.cwd(), ".tmp");
let root: string;
let srcRepo: string;
let targetDir: string;

function git(args: string[], cwd: string): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@muster.test", "-c", "user.name=muster-test", ...args],
    { cwd, encoding: "utf8" }
  ).trim();
}

function write(base: string, rel: string, content: string): void {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  root = fs.mkdtempSync(path.join(TMP_ROOT, "gitsrc-"));
  // Isolate the clone cache from the developer's real ~/.cache.
  process.env.MUSTER_CACHE_DIR = path.join(root, "cache");

  // A "remote" org config repo, with the tree under a subdirectory (monorepo shape).
  srcRepo = path.join(root, "org-repo");
  write(srcRepo, "README.md", "org repo");
  write(srcRepo, "configs/agent-config/instructions/00-org.md", "# Git Org\n\nRule one.");
  git(["init", "-b", "main"], srcRepo);
  git(["add", "-A"], srcRepo);
  git(["commit", "-m", "v1"], srcRepo);

  targetDir = path.join(root, "app");
  write(
    targetDir,
    "muster.yaml",
    [
      "version: 1",
      `source: ${JSON.stringify("file://" + srcRepo)}`,
      "ref: main",
      "path: configs/agent-config",
      "targets: [claude-code]",
      "",
    ].join("\n")
  );
});

afterAll(() => {
  delete process.env.MUSTER_CACHE_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("git URL source with subdirectory path", () => {
  it("clones the remote, reads the subdir tree, and records the commit", () => {
    const report = syncProject(targetDir);
    expect(report.sourceCommit).toBe(git(["rev-parse", "HEAD"], srcRepo));
    const agents = fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("Rule one.");
    expect(checkProject(targetDir).drift).toEqual([]);
  });

  it("sees remote updates as outdated, then syncs to the new commit", () => {
    write(srcRepo, "configs/agent-config/instructions/00-org.md", "# Git Org\n\nRule two.");
    git(["add", "-A"], srcRepo);
    git(["commit", "-m", "v2"], srcRepo);

    const check = checkProject(targetDir);
    expect(check.drift).toEqual([]);
    expect(check.outdated.map((o) => o.path)).toContain("AGENTS.md");

    const report = syncProject(targetDir);
    expect(report.sourceCommit).toBe(git(["rev-parse", "HEAD"], srcRepo));
    expect(fs.readFileSync(path.join(targetDir, "AGENTS.md"), "utf8")).toContain("Rule two.");
    expect(checkProject(targetDir).outdated).toEqual([]);
  });

  it("fails clearly when path does not exist in the source", () => {
    write(
      targetDir,
      "muster.yaml",
      [
        "version: 1",
        `source: ${JSON.stringify("file://" + srcRepo)}`,
        "ref: main",
        "path: configs/nope",
        "targets: [claude-code]",
        "",
      ].join("\n")
    );
    expect(() => syncProject(targetDir)).toThrow(/path "configs\/nope" not found/);
  });
});
