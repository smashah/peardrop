---
"@peardrop/cli": minor
---

Add `peardrop agent`, which prints the bundled agent skill and its references as one document (`--install` copies them into `~/.claude/skills` and `~/.agents/skills`, `--install --project` into the current project). The shipped skill is now a single fast path: create the inbox, write the spec, start `receive --json`, share the `share_ready` URL. Browser render gates, disposable-session proofs, and the pre-handoff receipt move to maintainer documents under `docs/` and no longer ship in the package. Root `--help` points agents at `peardrop agent`.
