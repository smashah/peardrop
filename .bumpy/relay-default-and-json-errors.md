---
'@peardrop/core': patch
'@peardrop/cli': patch
'@peardrop/relay': patch
---

Relay is named honestly as the default path, and `receive --json` can no longer leave a consumer with nothing to parse.

`--allow-relay` read as something you opt into even though it defaulted to `true`. It is replaced by `--relay`/`--no-relay`, so the documented surface matches the shipped behaviour: relay is on unless you pass `--no-relay`. `--allow-relay` and `--no-allow-relay` still parse as a hidden alias, so scripts written against 1.2.0 keep working (#22).

`receive --json` now emits one compact, flushed JSON line per event on stdout — the session with its drop URL, or `{"mode":"remote","event":"error","error":"…"}` with a non-zero exit when the session cannot start. Previously a failing session printed oclif's human-shaped prose to stderr and nothing parseable to stdout, and the session line itself was pretty-printed and unflushed, so a piped agent could lose it entirely.
