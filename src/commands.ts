import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, INIT_TEMPLATE, LOCK_FILE, loadConfig } from "./config.js";
import {
  extractManagedBlock,
  normalize,
  sha256,
  upsertManagedBlock,
  BEGIN_MARKER,
  END_MARKER,
} from "./compose.js";
import { applyJsonMerge, entriesHash, readManagedEntries } from "./mcp.js";
import { renderPlan } from "./render.js";
import { artifactLockEntry, readLock, writeLock } from "./lock.js";
import { loadSourceTree, resolveSource } from "./source.js";
import type {
  Artifact,
  CheckResult,
  Lockfile,
  SyncReport,
  WriteAction,
} from "./types.js";

function targetPath(cwd: string, artifactPath: string): string {
  return path.join(cwd, ...artifactPath.split("/"));
}

function readIfExists(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

/** Strip the managed block from a file, returning the remaining local content. */
function removeManagedBlock(text: string): string {
  const normalized = normalize(text);
  const begin = normalized.indexOf(BEGIN_MARKER);
  const end = normalized.indexOf(END_MARKER);
  if (begin === -1 || end === -1 || end <= begin) return normalized;
  return (normalized.slice(0, begin) + normalized.slice(end + END_MARKER.length)).trim();
}

function pruneEmptyDirs(startDir: string, stopDir: string): void {
  let dir = startDir;
  while (dir.startsWith(stopDir) && dir !== stopDir) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/**
 * Build the removal operation for a previously managed artifact: delete copies,
 * strip managed blocks/keys, and never touch content muster does not own.
 * Returns null when the file is already gone.
 */
function buildRemoval(
  cwd: string,
  artifactPath: string,
  entry: Lockfile["artifacts"][string]
): (() => void) | null {
  const abs = targetPath(cwd, artifactPath);
  if (!fs.existsSync(abs)) return null;
  if (entry.kind === "copy") {
    return () => {
      fs.rmSync(abs);
      // Climb toward the repo root removing now-empty directories (.claude/skills, .claude).
      pruneEmptyDirs(path.dirname(abs), cwd);
    };
  }
  if (entry.kind === "managed-block") {
    const rest = removeManagedBlock(fs.readFileSync(abs, "utf8"));
    return () => (rest.length > 0 ? fs.writeFileSync(abs, rest + "\n") : fs.rmSync(abs));
  }
  const stripped = applyJsonMerge(
    fs.readFileSync(abs, "utf8"),
    "mcpServers",
    {},
    entry.managedKeys ?? []
  );
  return () => fs.writeFileSync(abs, stripped);
}

export function initProject(cwd: string, opts: { force?: boolean } = {}): string {
  const file = path.join(cwd, CONFIG_FILE);
  if (fs.existsSync(file) && !opts.force) {
    throw new Error(`${CONFIG_FILE} already exists (use --force to overwrite)`);
  }
  fs.writeFileSync(file, INIT_TEMPLATE);
  return file;
}

export function syncProject(
  cwd: string,
  opts: { dryRun?: boolean } = {}
): SyncReport & { stale: boolean } {
  const config = loadConfig(cwd);
  const source = resolveSource(config.source, config.ref, cwd, config.path);
  const tree = loadSourceTree(source.dir, config);
  const plan = renderPlan(config, tree);
  const oldLock = readLock(cwd);

  const actions: { path: string; action: WriteAction }[] = [];
  const writes: { abs: string; content: string | Buffer }[] = [];
  const planPaths = new Set(plan.map((a) => a.path));

  for (const artifact of plan) {
    const abs = targetPath(cwd, artifact.path);
    const existing = readIfExists(abs);
    let next: string | Buffer;
    if (artifact.kind === "managed-block") {
      next = upsertManagedBlock(existing, artifact.body);
    } else if (artifact.kind === "json-merge") {
      const prevKeys = oldLock?.artifacts[artifact.path]?.managedKeys ?? [];
      try {
        next = applyJsonMerge(existing, artifact.root, artifact.entries, prevKeys);
      } catch (err) {
        throw new Error(`${artifact.path}: ${(err as Error).message}`);
      }
    } else {
      next = artifact.content;
    }

    let action: WriteAction;
    if (existing === null && !fs.existsSync(abs)) action = "create";
    else if (unchanged(abs, next)) action = "unchanged";
    else action = "update";

    actions.push({ path: artifact.path, action });
    if (action !== "unchanged") writes.push({ abs, content: next });
  }

  // Prune artifacts we managed before but that are gone from the source/targets.
  const removals: (() => void)[] = [];
  if (oldLock) {
    for (const [artifactPath, entry] of Object.entries(oldLock.artifacts)) {
      if (planPaths.has(artifactPath)) continue;
      const removal = buildRemoval(cwd, artifactPath, entry);
      if (!removal) continue;
      removals.push(removal);
      actions.push({ path: artifactPath, action: "delete" });
    }
  }

  if (!opts.dryRun) {
    for (const write of writes) {
      fs.mkdirSync(path.dirname(write.abs), { recursive: true });
      fs.writeFileSync(write.abs, write.content);
    }
    for (const removal of removals) removal();

    const lock: Lockfile = {
      version: 1,
      source: {
        ref: config.source,
        gitRef: config.ref ?? null,
        commit: source.commit,
        digest: source.digest,
      },
      artifacts: Object.fromEntries(plan.map((a) => [a.path, artifactLockEntry(a)])),
    };
    writeLock(cwd, lock);
  }

  return { actions, sourceCommit: source.commit, stale: source.stale };
}

function unchanged(abs: string, next: string | Buffer): boolean {
  if (!fs.existsSync(abs)) return false;
  const current = fs.readFileSync(abs);
  const desired = typeof next === "string" ? Buffer.from(next) : next;
  return current.equals(desired);
}

export function checkProject(cwd: string): CheckResult {
  const config = loadConfig(cwd);
  const lock = readLock(cwd);
  if (!lock) {
    throw new Error(`no muster.lock found — run \`muster sync\` first`);
  }

  const result: CheckResult = { drift: [], outdated: [], sourceUnavailable: false };

  for (const [artifactPath, entry] of Object.entries(lock.artifacts)) {
    const abs = targetPath(cwd, artifactPath);
    if (!fs.existsSync(abs)) {
      result.drift.push({ path: artifactPath, reason: "missing" });
      continue;
    }
    if (entry.kind === "managed-block") {
      const block = extractManagedBlock(fs.readFileSync(abs, "utf8"));
      if (block === null || sha256(block) !== entry.hash) {
        result.drift.push({ path: artifactPath, reason: "modified" });
      }
    } else if (entry.kind === "json-merge") {
      const managed = readManagedEntries(
        fs.readFileSync(abs, "utf8"),
        "mcpServers",
        entry.managedKeys ?? []
      );
      if (managed === null || entriesHash(managed) !== entry.hash) {
        result.drift.push({ path: artifactPath, reason: "modified" });
      }
    } else {
      if (sha256(fs.readFileSync(abs)) !== entry.hash) {
        result.drift.push({ path: artifactPath, reason: "modified" });
      }
    }
  }

  try {
    const source = resolveSource(config.source, config.ref, cwd, config.path);
    const tree = loadSourceTree(source.dir, config);
    const desired = new Map(
      renderPlan(config, tree).map((a: Artifact) => [a.path, artifactLockEntry(a)])
    );
    for (const [artifactPath, desiredEntry] of desired) {
      const locked = lock.artifacts[artifactPath];
      if (!locked) result.outdated.push({ path: artifactPath, reason: "new in source" });
      else if (locked.hash !== desiredEntry.hash) {
        result.outdated.push({ path: artifactPath, reason: "changed in source" });
      }
    }
    for (const artifactPath of Object.keys(lock.artifacts)) {
      if (!desired.has(artifactPath)) {
        result.outdated.push({ path: artifactPath, reason: "removed from source" });
      }
    }
  } catch {
    result.sourceUnavailable = true;
  }

  return result;
}

/**
 * Remove everything muster manages from this repo: strip managed blocks and
 * managed JSON keys, delete synced copies, and remove muster.lock.
 * muster.yaml is kept so the repo can re-sync later; delete it to fully eject.
 */
export function ejectProject(cwd: string): { removed: string[] } {
  loadConfig(cwd);
  const lock = readLock(cwd);
  if (!lock) {
    throw new Error(`no muster.lock found — nothing to eject`);
  }
  const removed: string[] = [];
  for (const [artifactPath, entry] of Object.entries(lock.artifacts)) {
    const removal = buildRemoval(cwd, artifactPath, entry);
    if (!removal) continue;
    removal();
    removed.push(artifactPath);
  }
  fs.rmSync(path.join(cwd, LOCK_FILE));
  return { removed };
}

export interface StatusInfo {
  source: Lockfile["source"] | null;
  artifacts: { path: string; kind: string; state: "ok" | "drift" | "outdated" }[];
  check: CheckResult | null;
}

export function statusProject(cwd: string): StatusInfo {
  loadConfig(cwd);
  const lock = readLock(cwd);
  if (!lock) return { source: null, artifacts: [], check: null };
  const check = checkProject(cwd);
  const driftPaths = new Set(check.drift.map((d) => d.path));
  const outdatedPaths = new Set(check.outdated.map((o) => o.path));
  const artifacts = Object.entries(lock.artifacts).map(([artifactPath, entry]) => ({
    path: artifactPath,
    kind: entry.kind,
    state: driftPaths.has(artifactPath)
      ? ("drift" as const)
      : outdatedPaths.has(artifactPath)
        ? ("outdated" as const)
        : ("ok" as const),
  }));
  return { source: lock.source, artifacts, check };
}
