---
'@peardrop/core': patch
'@peardrop/cli': patch
'@peardrop/relay': patch
---

Fixed `peardrop local` buffering its Drop URL / `--json` output behind un-awaited writes, so piped or backgrounded runs (how agents drive it) could see zero bytes for a long time. `--json` now emits compact single-line JSON, and SIGINT/SIGTERM exit cleanly with a session summary.
