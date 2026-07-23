# Acme Engineering — Agent Guide

These rules apply to every repository at Acme. They are distributed by
`muster` from the central `acme/agent-config` repo — propose changes there.

- Write tests for every behavior change. Bug fixes start with a failing test.
- Keep PRs under ~400 lines of diff. Split larger work.
- Never commit secrets. Configuration references environment variables.
- Prefer boring technology: reach for what the codebase already uses.
- All user-facing strings go through the i18n layer.
