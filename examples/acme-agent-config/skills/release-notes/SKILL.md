---
name: release-notes
description: Draft release notes from merged PRs since the last tag, in Acme's changelog voice.
---

# Release notes

When asked to draft release notes:

1. List merged PRs since the last git tag (`git log $(git describe --tags --abbrev=0)..HEAD --merges --oneline`).
2. Group changes as **Added / Changed / Fixed**, user-impact first, internal refactors last.
3. Write one line per change in imperative mood ("Add", not "Added"), linking the PR number.
4. Flag anything that needs a migration note and ask before publishing.
