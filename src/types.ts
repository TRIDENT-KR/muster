export const KNOWN_TARGETS = ["claude-code", "cursor", "copilot", "gemini-cli"] as const;
export type Target = (typeof KNOWN_TARGETS)[number];

export type Selection = "all" | string[];

export interface MusterConfig {
  version: 1;
  /** Local path (relative to the repo) or git URL of the org config source. */
  source: string;
  /** Optional git ref (branch, tag, or commit) when source is a git URL. */
  ref?: string;
  /** Optional subdirectory inside the source containing the config tree. */
  path?: string;
  /** Tool-specific outputs to render. AGENTS.md is always rendered. */
  targets: Target[];
  include?: {
    instructions?: Selection;
    skills?: Selection;
    mcp?: Selection;
  };
}

export interface InstructionFragment {
  /** Basename without .md, e.g. "00-org". Fragments compose in name order. */
  name: string;
  content: string;
}

export interface SkillFile {
  /** Path relative to the skill directory, e.g. "SKILL.md". */
  relPath: string;
  content: Buffer;
}

export interface Skill {
  name: string;
  files: SkillFile[];
}

/** Canonical MCP server definition (mcp/servers.yaml). Secrets must be ${ENV} references. */
export interface McpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface SourceTree {
  instructions: InstructionFragment[];
  skills: Skill[];
  mcpServers: Record<string, McpServer>;
}

export interface ResolvedSource {
  dir: string;
  /** Git commit if the source is (or resolves to) a git checkout. */
  commit: string | null;
  digest: string;
}

/** A file muster owns a managed region of (AGENTS.md, CLAUDE.md, copilot instructions). */
export interface ManagedBlockArtifact {
  kind: "managed-block";
  path: string;
  /** Body of the managed region (without markers). */
  body: string;
}

/** A JSON file where muster owns specific keys under a root object (.mcp.json). */
export interface JsonMergeArtifact {
  kind: "json-merge";
  path: string;
  root: string;
  entries: Record<string, unknown>;
}

/** A file muster owns entirely (synced skill files). */
export interface CopyArtifact {
  kind: "copy";
  path: string;
  content: Buffer;
}

export type Artifact = ManagedBlockArtifact | JsonMergeArtifact | CopyArtifact;

export interface LockArtifact {
  kind: Artifact["kind"];
  hash: string;
  /** For json-merge: the keys muster owns (used for pruning and drift checks). */
  managedKeys?: string[];
}

export interface Lockfile {
  version: 1;
  source: {
    ref: string;
    gitRef: string | null;
    commit: string | null;
    digest: string;
  };
  artifacts: Record<string, LockArtifact>;
}

export interface DriftEntry {
  path: string;
  reason: "missing" | "modified";
}

export interface OutdatedEntry {
  path: string;
  reason: "changed in source" | "new in source" | "removed from source";
}

export interface CheckResult {
  drift: DriftEntry[];
  outdated: OutdatedEntry[];
  /** True when the source could not be resolved (e.g. offline) and outdated info is unavailable. */
  sourceUnavailable: boolean;
}

export type WriteAction = "create" | "update" | "unchanged" | "delete";

export interface SyncReport {
  actions: { path: string; action: WriteAction }[];
  sourceCommit: string | null;
}
