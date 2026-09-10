---
"@peardrop/cli": minor
---

`receive` now waits for the Worker to confirm a new tunnel before reporting it shareable, so an agent no longer hands out a URL that can still 404 moments after creation. The receiver emits a new `share_ready` event once the tunnel is confirmed live (or `share_pending` with a reason if the Worker hasn't confirmed within a bounded wait — the receiver keeps running either way), and every event now carries a safe `cancelWith` reference instead of the receiver's owner token, which no longer appears anywhere in `--json` output. `--detach` is hidden in `--help` since background supervision isn't implemented; use a foreground receiver in its own pane instead.
