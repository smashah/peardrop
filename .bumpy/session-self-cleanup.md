---
"@peardrop/cli": patch
"@peardrop/core": patch
---

Sessions prune themselves, so `~/.peardrop/tunnels` stops growing without bound (#106). A receiver killed uncleanly — SIGKILL, machine sleep, a closed terminal — never got to write a terminal status, leaving its file at "waiting" forever with nothing to sweep it; `receive`, `local`, `status`, and `wait` now run core's new `pruneStaleSessions` first, which deletes expired "waiting" sessions whose receiver is no longer running and finished sessions older than a week, and never touches a session whose pid is alive. The sweep is silent in `--json` mode (one stderr line under `--verbose`) and a failure never blocks a drop. A receiver that ends without delivering records `cancelled` or the new `failed` status instead of leaving the file at "waiting", and `doctor --prune` now delegates to the same function.
