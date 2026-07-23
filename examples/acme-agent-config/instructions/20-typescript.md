## TypeScript

- `strict` mode is non-negotiable; do not add `any` to silence errors.
- Use ESM (`type: "module"`) and Node >= 20 APIs.
- Validate all external input at the boundary (zod or hand-rolled guards).
- Colocate tests as `*.test.ts` next to the code or under `test/`.
