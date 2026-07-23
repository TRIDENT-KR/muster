import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { validateServer } from "./mcp.js";
import type {
  MusterConfig,
  InstructionFragment,
  McpServer,
  ResolvedSource,
  Selection,
  Skill,
  SkillFile,
  SourceTree,
} from "./types.js";

const SKIP_DIRS = new Set([".git", "node_modules"]);

export function isGitUrl(spec: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(spec);
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function cacheDirFor(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  const base = process.env.MUSTER_CACHE_DIR ?? path.join(os.homedir(), ".cache", "muster");
  return path.join(base, "sources", hash);
}

/** Walk a directory and hash every file (sorted, .git excluded) into one digest. */
export function digestDir(dir: string): string {
  const files: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const relPath = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(relPath);
      else if (entry.isFile()) files.push(relPath);
    }
  };
  walk("");
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(dir, file)));
    hash.update("\0");
  }
  return "sha256:" + hash.digest("hex");
}

/**
 * Resolve the config source to a local directory. Git URLs are cloned into
 * ~/.cache/muster and updated on every run; when offline, the cached copy
 * is used and the caller is warned via the returned `stale` hint.
 */
export function resolveSource(
  spec: string,
  ref: string | undefined,
  cwd: string,
  subPath?: string
): ResolvedSource & { stale: boolean } {
  const withSubPath = (baseDir: string, commit: string | null, stale: boolean) => {
    const dir = subPath ? path.join(baseDir, ...subPath.split("/")) : baseDir;
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new Error(
        subPath
          ? `config source path "${subPath}" not found inside ${spec}`
          : `config source not found: ${dir}`
      );
    }
    return { dir, commit, digest: digestDir(dir), stale };
  };

  if (!isGitUrl(spec)) {
    const baseDir = path.resolve(cwd, spec);
    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
      throw new Error(`config source not found: ${baseDir}`);
    }
    const commit = tryGit(["rev-parse", "HEAD"], baseDir);
    return withSubPath(baseDir, commit, false);
  }

  const baseDir = cacheDirFor(spec);
  let stale = false;
  if (!fs.existsSync(path.join(baseDir, ".git"))) {
    fs.mkdirSync(path.dirname(baseDir), { recursive: true });
    fs.rmSync(baseDir, { recursive: true, force: true });
    try {
      const args = ["clone", "--depth", "1"];
      if (ref) args.push("--branch", ref);
      args.push(spec, baseDir);
      git(args);
    } catch {
      // --branch only works for branches/tags; fall back to a full clone for commit refs.
      fs.rmSync(baseDir, { recursive: true, force: true });
      git(["clone", spec, baseDir]);
      if (ref) git(["checkout", ref], baseDir);
    }
  } else {
    const updated =
      ref !== undefined
        ? tryGit(["fetch", "origin", ref], baseDir) !== null &&
          tryGit(["checkout", "FETCH_HEAD"], baseDir) !== null
        : tryGit(["pull", "--ff-only"], baseDir) !== null;
    if (!updated) stale = true;
  }
  const commit = tryGit(["rev-parse", "HEAD"], baseDir);
  return withSubPath(baseDir, commit, stale);
}

function selected(name: string, selection: Selection | undefined): boolean {
  if (selection === undefined || selection === "all") return true;
  return selection.includes(name);
}

/** A typo in `include` must fail loudly — a silently missing rule is a trust bug. */
function assertKnownNames(
  kind: "instructions" | "skills" | "mcp",
  selection: Selection | undefined,
  available: string[]
): void {
  if (selection === undefined || selection === "all") return;
  for (const name of selection) {
    if (!available.includes(name)) {
      const known = available.length > 0 ? available.join(", ") : "(none found in source)";
      throw new Error(
        `muster.yaml: include.${kind} references unknown name "${name}" — available: ${known}`
      );
    }
  }
}

function walkFiles(dir: string, rel = ""): SkillFile[] {
  const out: SkillFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const relPath = rel ? path.posix.join(rel, entry.name) : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(abs, relPath));
    else if (entry.isFile()) out.push({ relPath, content: fs.readFileSync(abs) });
  }
  return out;
}

/** Load instructions/, skills/, and mcp/servers.yaml from a resolved source dir. */
export function loadSourceTree(dir: string, config: MusterConfig): SourceTree {
  const include = config.include ?? {};

  const instructions: InstructionFragment[] = [];
  const instructionsDir = path.join(dir, "instructions");
  const availableInstructions = fs.existsSync(instructionsDir)
    ? fs
        .readdirSync(instructionsDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3))
        .sort()
    : [];
  assertKnownNames("instructions", include.instructions, availableInstructions);
  for (const name of availableInstructions) {
    if (!selected(name, include.instructions)) continue;
    instructions.push({
      name,
      content: fs.readFileSync(path.join(instructionsDir, `${name}.md`), "utf8"),
    });
  }

  const skills: Skill[] = [];
  const skillsDir = path.join(dir, "skills");
  const availableSkills = fs.existsSync(skillsDir)
    ? fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name))
        .map((e) => e.name)
        .sort()
    : [];
  assertKnownNames("skills", include.skills, availableSkills);
  for (const name of availableSkills) {
    if (!selected(name, include.skills)) continue;
    const skillDir = path.join(skillsDir, name);
    if (!fs.existsSync(path.join(skillDir, "SKILL.md"))) {
      throw new Error(`skill "${name}" is missing SKILL.md`);
    }
    skills.push({ name, files: walkFiles(skillDir) });
  }

  const mcpServers: Record<string, McpServer> = {};
  const serversFile = path.join(dir, "mcp", "servers.yaml");
  if (fs.existsSync(serversFile)) {
    const raw: unknown = parse(fs.readFileSync(serversFile, "utf8"));
    const servers =
      raw && typeof raw === "object" ? (raw as { servers?: unknown }).servers : undefined;
    if (servers !== undefined) {
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        throw new Error(`mcp/servers.yaml: "servers" must be a mapping of name -> definition`);
      }
      const entries = servers as Record<string, McpServer>;
      assertKnownNames("mcp", include.mcp, Object.keys(entries).sort());
      for (const [name, def] of Object.entries(entries)) {
        if (!selected(name, include.mcp)) continue;
        validateServer(name, def);
        mcpServers[name] = def;
      }
    }
  } else {
    assertKnownNames("mcp", include.mcp, []);
  }

  return { instructions, skills, mcpServers };
}
