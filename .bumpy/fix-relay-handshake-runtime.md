---
'@peardrop/core': patch
'@peardrop/cli': patch
---

Bundled the guarded relay handshake runtime into published browser and CLI artifacts so duplicate Noise frames after handshake completion cannot re-enter the completed state machine.
