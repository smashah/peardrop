---
'@peardrop/relay': patch
'@peardrop/core': patch
---

Fixed relay ticket admission so the browser-key non-custodial connection performs DHT reachability instead of being rejected by an incompatible relay-key preflight, and report DHT connection errors without crashing the sender process.
