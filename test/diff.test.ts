import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/diff.js";
import { diffProject, syncProject } from "../src/commands.js";

const TMP_ROOT = path.join(process.cwd(), ".tmp");
let testRoot: string;

function write(base: string, rel: string, content: string): void {
  const abs = path.join(base, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  testRoot = fs.mkdtempSync(path.join(TMP_ROOT, "diff-"));
});

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

describe("unifiedDiff", () => {
  it("returns empty for identical texts", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "f")).toBe("");
  });

  it("marks additions, deletions, and context", () => {
    const out = unifiedDiff("one\ntwo\nthree\n", "one\n2\nthree\n", "f.md");
    expect(out).toContain("--- a/f.md");
    expect(out).toContain("+++ b/f.md");
    expect(out).toContain("-two");
    expect(out).toContain("+2");
    expect(out).toContain(" one");
    expect(out).toContain(" three");
  });

  it("uses /dev/null for created and deleted files", () => {
    expect(unifiedDiff(null, "new\n", "f")).toContain("--- /dev/null");
    expect(unifiedDiff("old\n", null, "f")).toContain("+++ /dev/null");
  });

  it("keeps hunks local with @@ headers on long files", () => {
    const base = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n") + "\n";
    const changed = base.replace("line20", "LINE20");
    const out = unifiedDiff(base, changed, "big");
    expect(out).toContain("@@");
    expect(out).toContain("-line20");
    expect(out).toContain("+LINE20");
    // Far-away unchanged lines stay out of the hunk.
    expect(out).not.toContain("line1\n line2\n line3\n line4\n line5\n line6");
  });
});

describe("muster diff (project)", () => {
  it("previews source changes and goes quiet after sync", () => {
    const src = path.join(testRoot, "src");
    const app = path.join(testRoot, "app");
    write(src, "instructions/00-org.md", "# Org\n\nOld rule.");
    write(
      app,
      "muster.yaml",
      ["version: 1", `source: ${JSON.stringify(src)}`, "targets: [claude-code]", ""].join("\n")
    );

    // Before first sync everything is a create.
    const initial = diffProject(app);
    expect(initial.map((e) => e.action)).toContain("create");

    syncProject(app);
    expect(diffProject(app)).toEqual([]);

    write(src, "instructions/00-org.md", "# Org\n\nNew rule.");
    const changed = diffProject(app);
    const agents = changed.find((e) => e.path === "AGENTS.md");
    expect(agents?.action).toBe("update");
    expect(agents?.diff).toContain("-Old rule.");
    expect(agents?.diff).toContain("+New rule.");

    syncProject(app);
    expect(diffProject(app)).toEqual([]);
  });

  it("previews deletions when a target is dropped", () => {
    const src = path.join(testRoot, "src2");
    const app = path.join(testRoot, "app2");
    write(src, "instructions/00-org.md", "# Org2");
    write(
      app,
      "muster.yaml",
      ["version: 1", `source: ${JSON.stringify(src)}`, "targets: [claude-code, gemini-cli]", ""].join("\n")
    );
    syncProject(app);
    write(
      app,
      "muster.yaml",
      ["version: 1", `source: ${JSON.stringify(src)}`, "targets: [claude-code]", ""].join("\n")
    );
    const entries = diffProject(app);
    const gemini = entries.find((e) => e.path === "GEMINI.md");
    expect(gemini?.action).toBe("delete");
    expect(gemini?.diff).toContain("+++ /dev/null");
  });
});
