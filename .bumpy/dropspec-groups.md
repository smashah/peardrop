---
"@peardrop/core": minor
---

Adds a `[[groups]]` table so related fields (an API key + client ID + webhook secret from the same console) render as one visual block instead of an undifferentiated flat list of boxes, and four new per-field attributes — `scope`, `entry_url`, `resource_name`, `shown_once` — for values a recipient reads or carries *to* a provider rather than types in, rendered as chips/read-only-plus-copy instead of prose or an input.
