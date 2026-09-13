---
"@peardrop/cli": patch
"@peardrop/core": patch
---

Every command prints one stderr line when a newer `@peardrop/cli` is published (registry checked at most daily, in the background, from a cache under `~/.peardrop/latest.json`; `PEARDROP_NO_UPDATE_CHECK=1` disables it), so a stale global never silently carries an old agent skill (#115). Storage-sink preflights run in parallel on `receive`, `local`, and `hook test`. `doctor --prune` deletes session files for expired tunnels and week-old finished sessions whose receiver is gone. The live-DHT core test retries once with a longer budget (#100) and the release verifier waits up to two minutes for npm metadata (#105).
