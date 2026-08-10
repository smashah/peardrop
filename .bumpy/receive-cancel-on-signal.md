---
"@peardrop/cli": patch
---

`peardrop receive --relay` now tears its own tunnel down when interrupted with Ctrl-C or `kill <pid>` (SIGINT/SIGTERM), the same Worker cancellation `peardrop cancel` already performs. Previously, ending a session any way other than running `peardrop cancel` afterward left the drop page answering HTTP 200 — looking fully live — with no receiver actually listening, until the tunnel's TTL expired on its own.
