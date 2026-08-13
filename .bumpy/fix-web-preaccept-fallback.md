---
'@peardrop/core': patch
'@peardrop/cli': patch
---

Fall back immediately when the preferred browser relay transport closes before the receiver accepts the manifest, after fully tearing down the failed attempt.
