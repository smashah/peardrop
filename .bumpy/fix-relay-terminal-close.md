---
'@peardrop/core': patch
'@peardrop/cli': patch
---

Fail relay transfers immediately when an opened relay WebSocket closes instead of waiting for the phase timeout, and accept `test nc --verbose` for detailed production diagnostics.
