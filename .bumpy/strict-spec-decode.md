---
"@peardrop/core": patch
---

`decodeDropSpec` now rejects a spec containing a key it doesn't recognize instead of silently discarding it — an older `@peardrop/core` reading a spec with a field it predates (e.g. `link`) used to lose that data with zero indication anything was wrong. Now it throws a clear `DropSpecError` naming the unrecognized key instead.
