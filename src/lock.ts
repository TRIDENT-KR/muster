import fs from "node:fs";
import path from "node:path";
import { LOCK_FILE } from "./config.js";
import { managedBlockHash, sha256 } from "./compose.js";
import { entriesHash } from "./mcp.js";
import type { Artifact, LockArtifact, Lockfile } from "./types.js";

export function artifactLockEntry(artifact: Artifact): LockArtifact {
  switch (artifact.kind) {
    case "managed-block":
      return { kind: "managed-block", hash: managedBlockHash(artifact.body) };
    case "json-merge":
      return {
        kind: "json-merge",
        hash: entriesHash(artifact.entries),
        managedKeys: Object.keys(artifact.entries).sort(),
      };
    case "copy":
      return { kind: "copy", hash: sha256(artifact.content) };
  }
}

export function readLock(cwd: string): Lockfile | null {
  const file = path.join(cwd, LOCK_FILE);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Lockfile;
  if (parsed.version !== 1) {
    throw new Error(`${LOCK_FILE}: unsupported version ${String(parsed.version)}`);
  }
  return parsed;
}

export function writeLock(cwd: string, lock: Lockfile): void {
  const sorted: Lockfile = {
    ...lock,
    artifacts: Object.fromEntries(
      Object.entries(lock.artifacts).sort(([a], [b]) => a.localeCompare(b))
    ),
  };
  fs.writeFileSync(path.join(cwd, LOCK_FILE), JSON.stringify(sorted, null, 2) + "\n");
}
