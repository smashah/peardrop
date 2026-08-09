---
"@peardrop/core": patch
---

Spec drop pages now render bare http/https URLs in the top-level description, request copy, and per-field descriptions as real clickable links instead of inert escaped text, so a spec author can hand a receiver a working URL to the thing they're being asked to fetch. Also fixes a separate, pre-existing gap where an unescaped `<` in `JSON.stringify` output embedded inside a `<script>` tag let a field description containing a literal `</script>` break out of the embedded spec JSON.
