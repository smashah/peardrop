---
"@peardrop/cli": patch
"@peardrop/core": patch
---

A received value's plaintext file is now kept (and reported as a failed `file` result) whenever any `--store` sink failed, instead of being shredded as the only copy of a just-pasted secret. `receive --detach` gives the background receiver enough time for its sink preflights before declaring a readiness timeout (30 s per sink on top of the Worker budget).
