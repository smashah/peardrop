---
"@peardrop/core": patch
"@peardrop/cli": patch
---

`peardrop local --spec` now emits its browser program through a raw template and executes that program in regression coverage, proving three fields and their links render. Previously template-literal escaping corrupted the inline script, leaving a 200 page with no fields and no usable submit action.
