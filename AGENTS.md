# muster — contributor guide

TypeScript ESM CLI, Node >= 20. No default exports; small files with one concern each.

## Commands

- `npm run build` — tsc to `dist/`
- `npm test` — vitest (unit + lifecycle integration in `test/sync.test.ts`)
- `npm run dev -- <cmd>` — run the CLI from source, e.g. `npm run dev -- sync`

## Architecture

`cli.ts` (printing only) → `commands.ts` (sync/check/status orchestration) →
`render.ts` (artifact plan) built from `source.ts` (source resolution + loading)
using `compose.ts` (managed blocks) and `mcp.ts` (server rendering/merging), with
`lock.ts` hashing artifacts into `muster.lock`.

Invariants to preserve:

- `sync` is idempotent: second run must report all `unchanged`.
- Never touch content outside managed regions / managed JSON keys.
- Every artifact kind must support all three states: clean, drift, outdated.
- New artifact types need: render plan entry, lock hash, drift check, prune path, tests.

## Testing

Integration tests build real repos under `.tmp/` (never `os.tmpdir()` — sandboxed
environments). Add a lifecycle test for any new behavior; unit tests for pure logic.
