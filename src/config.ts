import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { KNOWN_TARGETS, type MusterConfig, type Selection, type Target } from "./types.js";

export const CONFIG_FILE = "muster.yaml";
export const LOCK_FILE = "muster.lock";

function parseSelection(value: unknown, field: string): Selection | undefined {
  if (value === undefined) return undefined;
  if (value === "all") return "all";
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value as string[];
  }
  throw new Error(`muster.yaml: "${field}" must be "all" or a list of names`);
}

export function parseConfig(text: string): MusterConfig {
  const raw: unknown = parse(text);
  if (!raw || typeof raw !== "object") {
    throw new Error("muster.yaml: expected a YAML mapping at the top level");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== 1) {
    throw new Error(`muster.yaml: unsupported version "${String(obj.version)}" (expected 1)`);
  }
  if (typeof obj.source !== "string" || obj.source.trim() === "") {
    throw new Error('muster.yaml: "source" is required (local path or git URL)');
  }
  if (obj.ref !== undefined && typeof obj.ref !== "string") {
    throw new Error('muster.yaml: "ref" must be a string');
  }
  if (!Array.isArray(obj.targets) || obj.targets.length === 0) {
    throw new Error(
      `muster.yaml: "targets" is required — one or more of: ${KNOWN_TARGETS.join(", ")}`
    );
  }
  for (const t of obj.targets) {
    if (!KNOWN_TARGETS.includes(t as Target)) {
      throw new Error(
        `muster.yaml: unknown target "${String(t)}" (known: ${KNOWN_TARGETS.join(", ")})`
      );
    }
  }

  let include: MusterConfig["include"];
  if (obj.include !== undefined) {
    if (!obj.include || typeof obj.include !== "object") {
      throw new Error('muster.yaml: "include" must be a mapping');
    }
    const inc = obj.include as Record<string, unknown>;
    include = {
      instructions: parseSelection(inc.instructions, "include.instructions"),
      skills: parseSelection(inc.skills, "include.skills"),
      mcp: parseSelection(inc.mcp, "include.mcp"),
    };
  }

  return {
    version: 1,
    source: obj.source,
    ref: obj.ref as string | undefined,
    targets: obj.targets as Target[],
    include,
  };
}

export function loadConfig(cwd: string): MusterConfig {
  const file = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`no ${CONFIG_FILE} found in ${cwd} — run \`muster init\` first`);
  }
  return parseConfig(fs.readFileSync(file, "utf8"));
}

export const INIT_TEMPLATE = `# muster — org-wide configuration for AI coding agents.
version: 1

# Where your org's agent config lives: a local path or a git URL.
#   source: git@github.com:acme/agent-config.git
#   ref: main
source: ../agent-config

# Tool-specific outputs to render. AGENTS.md is always rendered.
#   claude-code -> CLAUDE.md bridge, .claude/skills/, .mcp.json
#   cursor      -> .cursor/mcp.json (Cursor reads AGENTS.md natively)
#   copilot     -> .github/copilot-instructions.md
targets:
  - claude-code
  - cursor

# Optionally select a subset of the source. Defaults to all.
# include:
#   instructions: all
#   skills: [release-notes]
#   mcp: [github]
`;
