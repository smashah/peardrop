---
"@peardrop/core": patch
"@peardrop/cli": patch
---

PearDrop now accepts `peardrop <slug> <text>` as the default send form, labels relay as fallback permission instead of the selected transport, reports the actual connection plus direct-transfer phase timings, emits structured connection and delivery events, and exits the one-time receiver after its acknowledged delivery.
