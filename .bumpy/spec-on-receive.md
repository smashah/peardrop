---
'@peardrop/core': minor
'@peardrop/cli': minor
'@peardrop/relay': minor
---

`receive` takes `--spec`/`--spec-inline`, so a remote drop page can be as self-explanatory as a local one.

Until now only `local` could read a TOML drop-page spec, which meant every remote drop was a generic "paste something" box with no title, no description and no field labels — the mode most people actually use from a phone (#26). `receive --spec <file>` and `receive --spec-inline '<toml>'` now parse and validate the spec before the Worker is ever asked for a tunnel, exactly the way `local` validates before it starts a server, and send the parsed spec with the tunnel registration so peardrop.fyi can render the page it describes. A spec's `[hooks] on_receive` is honoured too, with `--on-receive` still overriding it.

`@peardrop/core` gains `decodeDropSpec`, which validates an already-parsed spec object — the JSON form the Worker receives — against the same schema, defaults and duplicate/regex rules `parseDropSpecToml` applies to TOML text, so both ends judge a spec identically.
