---
"@peardrop/cli": patch
---

Document a hosted one-token spec with protected-directory shell setup and a `share_ready` handoff, linked to the canonical skill. `--version` now reports the invoked executable and alternative PATH installations on stderr, making stale global copies visible without changing JSON receiver output or executing another CLI. Repository checks and spec fixtures now resolve files portably on the declared Node 20 minimum.

Hosted OAuth instructions now use the rendered redirect URI, resource name, and scopes without duplicating those values in descriptions.
