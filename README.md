# muster

**Org-wide control plane for AI coding agent configuration.**
One source of truth → `AGENTS.md`, `CLAUDE.md`, skills, and MCP config — rendered, synced, and drift-checked across every repo and every tool.

Does your repo pass muster?

> Status: **v0.1 experimental.** Interfaces will change.

```bash
npm install -g @musterdev/cli
```

## The problem

Your team runs Claude Code, Cursor, and Copilot side by side. Which means every repo now carries a pile of hand-maintained agent config:

- `CLAUDE.md` — copy-pasted between repos, all slightly different, quietly rotting
- `AGENTS.md` — the standard everyone else reads, drifting from `CLAUDE.md`
- `.claude/skills/` — that great skill your teammate wrote, living only on their laptop
- `.mcp.json` / `.cursor/mcp.json` — shared by pasting JSON into Slack, sometimes with a token in it

Nobody owns these files, nothing keeps them in sync, and the instructions you give your agents — the things now writing half your code — are the least-managed asset in your org.

`muster` treats agent configuration like the infrastructure it is: **declared once in a central repo, compiled to each tool's native format, verified in CI.**

## Quickstart

```bash
# in a target repo
muster init      # creates muster.yaml
muster sync      # renders org config into this repo
muster check     # exit 1 on drift — wire this into CI
muster status    # see what's managed and its state
muster eject     # remove everything muster manages, keep your local content
```

`muster.yaml`:

```yaml
version: 1
source: git@github.com:acme/agent-config.git   # or a local path
ref: main
# path: configs/agent-config                   # optional subdir inside the source
targets: [claude-code, cursor, copilot]
include:            # optional, defaults to all
  skills: [release-notes]
  mcp: [github]
```

Your org's `agent-config` repo:

```
agent-config/
  instructions/          # markdown fragments, composed in filename order
    00-org.md
    20-typescript.md
  skills/                # standard SKILL.md directories
    release-notes/SKILL.md
  mcp/
    servers.yaml         # approved MCP servers; secrets must be ${ENV} refs
```

## What gets rendered

| Output | For | Notes |
|---|---|---|
| `AGENTS.md` | every tool that reads the standard | managed block on top, your repo-local content preserved below |
| `CLAUDE.md` | Claude Code | bridge file importing `@AGENTS.md` |
| `.claude/skills/*` | Claude Code | skills synced from the org library |
| `.mcp.json` | Claude Code | only org-managed server keys touched; personal servers left alone |
| `.cursor/mcp.json` | Cursor | same merge semantics |
| `.github/copilot-instructions.md` | GitHub Copilot | managed block |

Three guarantees:

1. **Local content survives.** Managed regions are marked; everything outside them is yours. JSON merges only own their keys.
2. **Drift is visible.** `muster check` distinguishes *drift* (someone hand-edited a managed file → exit 1, it *fails muster*) from *outdated* (the source moved → run sync).
3. **No secrets in git.** Server configs that contain literal tokens are rejected at sync time — use `${ENV_VAR}` references.

## Try the demo

```bash
git clone https://github.com/TRIDENT-KR/muster && cd muster && npm install && npm run build
cd examples/demo-app
node ../../dist/cli.js sync && node ../../dist/cli.js check
```

## Env references in MCP configs

Write secrets as `${VAR}` in `mcp/servers.yaml` — muster renders the right syntax per client: `${VAR}` for Claude Code (expanded natively) and `${env:VAR}` for Cursor. Avoid `${VAR:-default}` in shared configs; it is Claude Code-only.

## Honest support matrix

- Instruction composition and drift checking: solid, tested.
- MCP rendering: verified against official Claude Code and Cursor docs (July 2026) — Claude Code requires `type: "http"` for remote servers (we emit it) and expands `${VAR}`; Cursor entries get `${env:VAR}` rewritten automatically.
- Live-verified with Claude Code 2.1: rendered `.mcp.json` servers are recognized (`claude mcp list`), the `CLAUDE.md → @AGENTS.md` bridge delivers org instructions in headless runs, and synced `.claude/skills/` appear as available skills. This repo also manages itself with muster (`muster check` gates CI).
- The `CLAUDE.md → @AGENTS.md` bridge is necessary and correct: Claude Code does not read AGENTS.md natively, and imports resolve up to 4 hops.
- Skills: synced to `.claude/skills/<name>/SKILL.md` (verified location; frontmatter optional, extra files supported). Other tools adopting the SKILL.md standard read from their own locations — adapters coming as we verify each one.
- Copilot: `.github/copilot-instructions.md` is current for Chat/Code Review; the Copilot Coding Agent also reads our rendered AGENTS.md.
- Windows: untested.

## Roadmap

- **v0.2** — GitHub App: PR-based rollout of source changes across all repos (Renovate-style), org dashboard
- **v0.3** — policy: required skills, MCP allowlists, `check --strict` gates
- **v0.4** — measurement: which instructions actually improve agent outcomes

## License

MIT
