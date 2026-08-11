---
"@peardrop/cli": patch
---

`peardrop receive` now stops waiting and reports an actionable error when its authenticated Worker status check says the tunnel registration has disappeared. Previously the receiver process could continue presenting itself as healthy after its public drop link was already dead.
