---
'@peardrop/core': minor
'@peardrop/cli': minor
'@peardrop/relay': minor
---

Drops can now run a command once the payload is confirmed written: `[hooks] on_receive` in a TOML spec, or `--on-receive <command>` on `peardrop local` and `peardrop receive` (the flag overrides the spec). The hook is told about the drop through `PEARDROP_TARGET_PATH`, `PEARDROP_FILE_PATHS`, and `PEARDROP_FILE_COUNT` — never on argv, and the raw secret value is never passed at all, so nothing sensitive reaches a process listing. A non-zero hook exit is logged to stderr and reported on `local --json`'s closing line, but never un-writes the delivered secret (#8).

Delivered filenames now have control characters stripped alongside the existing basename reduction, so a sender-chosen name cannot forge entries in the newline-separated `PEARDROP_FILE_PATHS`.
