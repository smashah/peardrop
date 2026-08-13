---
"@peardrop/cli": patch
"@peardrop/core": patch
---

`test nc` now invokes the exact shared web-sender boundary (`sendRelay` from `@peardrop/core/relay`) that the hosted browser drop page, forced `send --relay`, and the relay e2e harness all use — it no longer spawns a CLI subprocess approximation of the protocol. After any failure, timeout, SIGINT, or SIGTERM, the diagnostic awaits bounded sender teardown and then watches the receiver for a documented 2-second terminal-consistency window; if the receiver delivers bytes the sender can no longer see — the invisible-live-attempt-after-failure condition behind the reported `dusky-nectar-yz7` Brand Store incident — the diagnostic turns red at `late-delivery` instead of reporting success from eventual byte delivery. Events are labeled `receiver`, `web-sender`, `relay`, or `harness` with monotonic phase timings. The on-receive hook now exports `resolveBunFromEnv` and documents that hooks always execute through the shell (`shell: true`) so Bun is resolved from `$PATH` (`PEARDROP_BUN` > `BUN` > bare `bun`) and never hardcoded to a machine-specific absolute path.
