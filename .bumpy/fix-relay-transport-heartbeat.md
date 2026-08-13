---
'@peardrop/relay': patch
---

Keep accepted relay WebSockets active with control-frame heartbeats while a non-custodial DHT connection is still pending, preventing idle transport closure before the peer path opens.
