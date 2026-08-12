---
"@peardrop/core": patch
"@peardrop/cli": patch
---

PearDrop now accepts `peardrop <slug> <text>` as the default send form, labels relay as fallback permission instead of the selected transport, reports the actual connection plus direct-transfer phase timings, emits structured connection and delivery events, and exits the one-time receiver after its acknowledged delivery. Forced `send --relay` transfers now share the hosted sender's non-custodial-first Relay state machine, and `test nc` performs a disposable non-custodial production diagnostic with exact byte, hash, lifecycle, cleanup, and tunnel-consumption checks.
