---
"@peardrop/cli": patch
"@peardrop/core": patch
---

Relay sends now fail instead of automatically downgrading to custodial mode. The CLI shows its non-custodial mode before sending and explains that fallback was disabled on failure. The core sender defaults to no fallback while retaining explicitly requested custodial support for compatibility.
