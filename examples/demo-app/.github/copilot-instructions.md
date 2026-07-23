<!-- muster:begin -->
<!-- Managed by muster. Edits inside this block will be overwritten — update the config source and run `muster sync`. -->

# Acme Engineering — Agent Guide

These rules apply to every repository at Acme. They are distributed by
`muster` from the central `acme/agent-config` repo — propose changes there.

- Write tests for every behavior change. Bug fixes start with a failing test.
- Keep PRs under ~400 lines of diff. Split larger work.
- Never commit secrets. Configuration references environment variables.
- Prefer boring technology: reach for what the codebase already uses.
- All user-facing strings go through the i18n layer.

## TypeScript

- `strict` mode is non-negotiable; do not add `any` to silence errors.
- Use ESM (`type: "module"`) and Node >= 20 APIs.
- Validate all external input at the boundary (zod or hand-rolled guards).
- Colocate tests as `*.test.ts` next to the code or under `test/`.

<!-- muster:end -->
