import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { normalize } from "./compose.js";
import { findSecretLabel } from "./mcp.js";
import { CONFIG_FILE, LOCK_FILE } from "./config.js";
import type { McpServer, Target } from "./types.js";

export interface AdoptReport {
  /** Instruction fragments written into the source, with their origin file. */
  fragments: { file: string; from: string }[];
  /** Skill names copied into the source. */
  skills: string[];
  /** MCP servers adopted, with their origin file. */
  servers: { name: string; from: string }[];
  /** Literal secrets that were replaced with ${ENV} references (never copied). */
  secretsReplaced: { server: string; field: string; ref: string }[];
  /** Files deleted because their content was fully captured into the source. */
  captured: string[];
  /** Things detected but deliberately not auto-adopted — review manually. */
  notes: string[];
  targets: Target[];
  sourceDir: string;
}

function read(cwd: string, rel: string): string | null {
  const abs = path.join(cwd, rel);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

function same(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && normalize(a).trim() === normalize(b).trim();
}

/** A CLAUDE.md that only bridges to AGENTS.md carries no content of its own. */
function isBridge(text: string): boolean {
  const t = normalize(text).trim();
  return t === "@AGENTS.md" || (t.includes("@AGENTS.md") && t.length < 40);
}

function parseJsonServers(
  cwd: string,
  rel: string,
  notes: string[]
): Record<string, McpServer> | null {
  const text = read(cwd, rel);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, McpServer> };
    return parsed.mcpServers ?? null;
  } catch {
    notes.push(`${rel}: could not parse as JSON (comments?) — skipped, adopt it manually`);
    return null;
  }
}

const CURSOR_ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Canonicalize an entry: cursor ${env:X} -> ${X}, drop client-specific fields. */
function canonicalize(entry: McpServer & { type?: string }): McpServer {
  const mapStr = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(CURSOR_ENV_REF, "${$1}");
    if (Array.isArray(v)) return v.map(mapStr);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, mapStr(x)])
      );
    }
    return v;
  };
  const out: McpServer = {};
  if (entry.command) {
    out.command = mapStr(entry.command) as string;
    if (entry.args) out.args = mapStr(entry.args) as string[];
    if (entry.env) out.env = mapStr(entry.env) as Record<string, string>;
  } else if (entry.url) {
    out.url = mapStr(entry.url) as string;
    if (entry.headers) out.headers = mapStr(entry.headers) as Record<string, string>;
  }
  return out;
}

const toEnvName = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

/** Replace literal secrets with ${ENV} references. Secrets are never copied into the source. */
function scrubSecrets(name: string, server: McpServer, report: AdoptReport): McpServer {
  const out: McpServer = { ...server };
  if (out.env) {
    out.env = Object.fromEntries(
      Object.entries(out.env).map(([key, value]) => {
        if (findSecretLabel(value)) {
          const ref = `\${${key}}`;
          report.secretsReplaced.push({ server: name, field: `env.${key}`, ref });
          return [key, ref];
        }
        return [key, value];
      })
    );
  }
  if (out.headers) {
    out.headers = Object.fromEntries(
      Object.entries(out.headers).map(([key, value]) => {
        if (findSecretLabel(value)) {
          const ref = `\${${toEnvName(key)}}`;
          report.secretsReplaced.push({ server: name, field: `headers.${key}`, ref });
          return [key, ref];
        }
        return [key, value];
      })
    );
  }
  for (const field of ["command", "url"] as const) {
    const value = out[field];
    if (value && findSecretLabel(value)) {
      const ref = `\${${toEnvName(field)}}`;
      out[field] = ref;
      report.secretsReplaced.push({ server: name, field, ref });
    }
  }
  if (out.args) {
    out.args = out.args.map((arg, i) => {
      if (findSecretLabel(arg)) {
        const ref = `\${ARG_${i}}`;
        report.secretsReplaced.push({ server: name, field: `args[${i}]`, ref });
        return ref;
      }
      return arg;
    });
  }
  return out;
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

/**
 * Scan existing agent config in a repo and extract it into a muster source
 * directory. Fully captured originals are deleted (sync recreates them managed);
 * anything ambiguous is reported, never merged silently.
 */
export function adoptProject(
  cwd: string,
  opts: { dir?: string; dryRun?: boolean } = {}
): AdoptReport {
  if (fs.existsSync(path.join(cwd, CONFIG_FILE))) {
    throw new Error(`${CONFIG_FILE} already exists — this repo is already set up (use \`muster sync\`)`);
  }
  if (fs.existsSync(path.join(cwd, LOCK_FILE))) {
    throw new Error(`${LOCK_FILE} already exists — this repo is already managed`);
  }
  const dirName = opts.dir ?? "agent-config";
  const sourceDir = path.join(cwd, dirName);
  if (fs.existsSync(sourceDir) && fs.readdirSync(sourceDir).length > 0) {
    throw new Error(`${dirName}/ already exists and is not empty — pass --dir to choose another location`);
  }

  const report: AdoptReport = {
    fragments: [],
    skills: [],
    servers: [],
    secretsReplaced: [],
    captured: [],
    notes: [],
    targets: [],
    sourceDir: dirName,
  };

  const agentsMd = read(cwd, "AGENTS.md");
  const claudeMd = read(cwd, "CLAUDE.md");
  const geminiMd = read(cwd, "GEMINI.md");
  const cursorrules = read(cwd, ".cursorrules");
  const copilotMd = read(cwd, ".github/copilot-instructions.md");
  const claudeBridge = claudeMd !== null && isBridge(claudeMd);

  // --- instructions ---
  const writes: { rel: string; content: string }[] = [];
  const deletions: string[] = [];
  let primary: string | null = null;

  if (agentsMd !== null) {
    primary = agentsMd;
    writes.push({ rel: "instructions/00-adopted.md", content: agentsMd });
    report.fragments.push({ file: "instructions/00-adopted.md", from: "AGENTS.md" });
    deletions.push("AGENTS.md");
  } else if (claudeMd !== null && !claudeBridge) {
    primary = claudeMd;
    writes.push({ rel: "instructions/00-adopted.md", content: claudeMd });
    report.fragments.push({ file: "instructions/00-adopted.md", from: "CLAUDE.md" });
  } else if (geminiMd !== null) {
    primary = geminiMd;
    writes.push({ rel: "instructions/00-adopted.md", content: geminiMd });
    report.fragments.push({ file: "instructions/00-adopted.md", from: "GEMINI.md" });
    deletions.push("GEMINI.md");
  }

  if (claudeMd !== null) {
    if (claudeBridge || same(claudeMd, primary)) {
      deletions.push("CLAUDE.md"); // recreated as the managed bridge by sync
    } else if (agentsMd !== null) {
      writes.push({ rel: "instructions/10-adopted-claude.md", content: claudeMd });
      report.fragments.push({ file: "instructions/10-adopted-claude.md", from: "CLAUDE.md (differed from AGENTS.md)" });
      deletions.push("CLAUDE.md");
    } else {
      deletions.push("CLAUDE.md"); // it IS the primary, captured above
    }
  }

  if (cursorrules !== null) {
    writes.push({ rel: "instructions/20-adopted-cursorrules.md", content: cursorrules });
    report.fragments.push({ file: "instructions/20-adopted-cursorrules.md", from: ".cursorrules" });
    deletions.push(".cursorrules");
  }
  if (fs.existsSync(path.join(cwd, ".cursor", "rules"))) {
    report.notes.push(".cursor/rules/ detected — path-scoped rules are not auto-adopted; keeping them as-is");
  }

  const handleDerived = (rel: string, content: string | null, target: Target) => {
    if (content === null) return;
    if (primary !== null && same(content, primary)) {
      deletions.push(rel);
      report.captured.push(rel);
      if (!report.targets.includes(target)) report.targets.push(target);
    } else if (primary !== null) {
      report.notes.push(`${rel} differs from the adopted instructions — review and merge manually before enabling the ${target} target`);
    }
  };
  handleDerived(".github/copilot-instructions.md", copilotMd, "copilot");
  if (agentsMd !== null || (claudeMd !== null && !claudeBridge)) {
    handleDerived("GEMINI.md", geminiMd, "gemini-cli");
  }

  // --- skills ---
  const skillsRoot = path.join(cwd, ".claude", "skills");
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md"))) {
        report.notes.push(`.claude/skills/${entry.name}/ has no SKILL.md — skipped`);
        continue;
      }
      report.skills.push(entry.name);
    }
  }

  // --- mcp servers ---
  const claudeServers = parseJsonServers(cwd, ".mcp.json", report.notes);
  const cursorServers = parseJsonServers(cwd, ".cursor/mcp.json", report.notes);
  const merged: Record<string, McpServer> = {};
  for (const [origin, servers] of [
    [".mcp.json", claudeServers],
    [".cursor/mcp.json", cursorServers],
  ] as const) {
    if (!servers) continue;
    for (const [name, entry] of Object.entries(servers)) {
      const canonical = scrubSecrets(name, canonicalize(entry), report);
      if (name in merged) {
        if (JSON.stringify(merged[name]) !== JSON.stringify(canonical)) {
          report.notes.push(`mcp server "${name}" differs between .mcp.json and .cursor/mcp.json — kept the .mcp.json version`);
        }
        continue;
      }
      merged[name] = canonical;
      report.servers.push({ name, from: origin });
    }
  }

  // --- infer targets ---
  const addTarget = (t: Target) => {
    if (!report.targets.includes(t)) report.targets.push(t);
  };
  if (claudeMd !== null || claudeServers || report.skills.length > 0 || fs.existsSync(path.join(cwd, ".claude"))) {
    addTarget("claude-code");
  }
  if (cursorServers || cursorrules !== null || fs.existsSync(path.join(cwd, ".cursor"))) {
    addTarget("cursor");
  }
  if (report.targets.length === 0) addTarget("claude-code");

  if (report.fragments.length === 0 && report.skills.length === 0 && report.servers.length === 0) {
    throw new Error(
      "nothing to adopt — no AGENTS.md, CLAUDE.md, GEMINI.md, .cursorrules, .claude/skills/, or mcp configs found"
    );
  }

  // --- write everything ---
  if (!opts.dryRun) {
    for (const w of writes) {
      const abs = path.join(sourceDir, ...w.rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, normalize(w.content).trim() + "\n");
    }
    for (const skill of report.skills) {
      copyDir(path.join(skillsRoot, skill), path.join(sourceDir, "skills", skill));
    }
    if (Object.keys(merged).length > 0) {
      const abs = path.join(sourceDir, "mcp", "servers.yaml");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(
        abs,
        "# Adopted by `muster adopt`. Secrets were replaced with ${ENV} references.\n" +
          stringify({ servers: merged })
      );
    }
    fs.writeFileSync(
      path.join(cwd, CONFIG_FILE),
      [
        "# Created by `muster adopt`. Point `source` at a shared git repo when you",
        "# are ready to distribute this config to other repositories.",
        "version: 1",
        `source: ./${dirName}`,
        `targets: [${report.targets.join(", ")}]`,
        "",
      ].join("\n")
    );
    for (const rel of deletions) {
      const abs = path.join(cwd, rel);
      if (fs.existsSync(abs)) {
        fs.rmSync(abs);
        if (!report.captured.includes(rel)) report.captured.push(rel);
      }
    }
  } else {
    report.captured.push(...deletions.filter((d) => fs.existsSync(path.join(cwd, d))));
  }

  return report;
}
