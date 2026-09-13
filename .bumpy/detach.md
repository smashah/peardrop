---
"@peardrop/cli": minor
"@peardrop/core": minor
---

`receive --detach` is implemented (#88, #112): the CLI registers the tunnel, prints `session` and `share_ready`/`share_pending`, and leaves the receiver running as a background process whose event stream is appended to a 0600 log under `~/.peardrop/logs`. New `peardrop wait <slug>` follows a detached receiver to its terminal event; `status` reports the receiver pid, liveness, and last event; `cancel` stops the background process before tearing the tunnel down. Sessions record `pid` and `logPath`. The on_receive hook now runs with the CLI's working directory so relative paths resolve where the operator ran it (#85).
