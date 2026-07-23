import path from "node:path";
import { composeFragments } from "./compose.js";
import { toClaudeEntry, toCursorEntry } from "./mcp.js";
import type { MusterConfig, Artifact, SourceTree } from "./types.js";

export const AGENTS_MD = "AGENTS.md";
export const CLAUDE_MD = "CLAUDE.md";
export const CLAUDE_BRIDGE_BODY = "@AGENTS.md";
export const COPILOT_INSTRUCTIONS = ".github/copilot-instructions.md";
export const CLAUDE_MCP_JSON = ".mcp.json";
export const CURSOR_MCP_JSON = ".cursor/mcp.json";
export const CLAUDE_SKILLS_DIR = ".claude/skills";

/**
 * Compute the full set of artifacts for a target repo.
 * AGENTS.md is the canonical output; tool targets add bridges and native config.
 */
export function renderPlan(config: MusterConfig, tree: SourceTree): Artifact[] {
  const artifacts: Artifact[] = [];
  const instructionsBody = composeFragments(tree.instructions);

  artifacts.push({ kind: "managed-block", path: AGENTS_MD, body: instructionsBody });

  if (config.targets.includes("claude-code")) {
    artifacts.push({ kind: "managed-block", path: CLAUDE_MD, body: CLAUDE_BRIDGE_BODY });

    for (const skill of tree.skills) {
      for (const file of skill.files) {
        artifacts.push({
          kind: "copy",
          path: path.posix.join(CLAUDE_SKILLS_DIR, skill.name, file.relPath),
          content: file.content,
        });
      }
    }

    if (Object.keys(tree.mcpServers).length > 0) {
      artifacts.push({
        kind: "json-merge",
        path: CLAUDE_MCP_JSON,
        root: "mcpServers",
        entries: Object.fromEntries(
          Object.entries(tree.mcpServers).map(([name, server]) => [name, toClaudeEntry(server)])
        ),
      });
    }
  }

  if (config.targets.includes("cursor") && Object.keys(tree.mcpServers).length > 0) {
    artifacts.push({
      kind: "json-merge",
      path: CURSOR_MCP_JSON,
      root: "mcpServers",
      entries: Object.fromEntries(
        Object.entries(tree.mcpServers).map(([name, server]) => [name, toCursorEntry(server)])
      ),
    });
  }

  if (config.targets.includes("copilot")) {
    artifacts.push({ kind: "managed-block", path: COPILOT_INSTRUCTIONS, body: instructionsBody });
  }

  return artifacts;
}
