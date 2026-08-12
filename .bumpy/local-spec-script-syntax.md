---
"@peardrop/core": patch
"@peardrop/cli": patch
---

`peardrop local --spec` now emits valid browser JavaScript when rendering linkified descriptions and all-or-nothing group copy. Previously template-literal escaping corrupted the inline script, leaving a 200 page with no fields and no usable submit action.
