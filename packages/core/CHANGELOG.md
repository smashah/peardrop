# Changelog


## 1.2.0
<sub>2026-08-07</sub>

- [#20](https://github.com/smashah/peardrop/pull/20) [`bd24274`](https://github.com/smashah/peardrop/commit/bd24274a33f511fe6c034a324943461d5616b220)  *(minor)*
  Relay transfers are now free up to 5MB, and `peardrop receive` no longer needs a wallet to start.

  `calculateRelayFee`'s free threshold moved from `0` bytes to 5MB, with the existing schedule shifted above it (`5MB–50MB = $0.01`, `50MB–500MB = $0.02`, then the unchanged variable rate) and every boundary exposed as a named constant.

  `--allow-relay` (still on by default) is a policy flag again: it no longer signs a payment authorization at session creation, so a receiver with no wallet starts normally instead of hard-failing before any transfer exists. The wallet is loaded lazily — only once the Worker reports relayed bytes trending over the free tier — and a missing wallet is reported there with an actionable message ([#17](https://github.com/smashah/peardrop/issues/17)).
- [#18](https://github.com/smashah/peardrop/pull/18) [`9a64f6c`](https://github.com/smashah/peardrop/commit/9a64f6c1934cbbbb649514aeb87e854c94a98e17)  *(minor)*
  Drops can now run a command once the payload is confirmed written: `[hooks] on_receive` in a TOML spec, or `--on-receive <command>` on `peardrop local` and `peardrop receive` (the flag overrides the spec). The hook is told about the drop through `PEARDROP_TARGET_PATH`, `PEARDROP_FILE_PATHS`, and `PEARDROP_FILE_COUNT` — never on argv, and the raw secret value is never passed at all, so nothing sensitive reaches a process listing. A non-zero hook exit is logged to stderr and reported on `local --json`'s closing line, but never un-writes the delivered secret ([#8](https://github.com/smashah/peardrop/issues/8)).

  Delivered filenames now have control characters stripped alongside the existing basename reduction, so a sender-chosen name cannot forge entries in the newline-separated `PEARDROP_FILE_PATHS`.

## 1.1.0
<sub>2026-08-07</sub>

- [#3](https://github.com/smashah/peardrop/pull/3) [`239fd97`](https://github.com/smashah/peardrop/commit/239fd97d2ee2ba307191b8e87c044dc3818332d4)  *(minor)*
  `peardrop local` gained `--spec`/`--spec-inline` TOML drop-page specs: multiple named fields (secret/text/file/token), per-field validation, and copy overrides, with client- and server-side validation and a resubmittable single-use link on failure (peardrop.fyi#15).

  Also fixed `peardrop local` buffering its Drop URL / `--json` output behind un-awaited writes, so piped or backgrounded runs (how agents drive it) could see zero bytes for a long time. `--json` now emits compact single-line JSON, and SIGINT/SIGTERM exit cleanly with a session summary ([#2](https://github.com/smashah/peardrop/issues/2)).
- [`0c1ff99`](https://github.com/smashah/peardrop/commit/0c1ff99f91bf6aceb2a8fd36714c778ecd70c918)  *(patch)*
  Moved the PearDrop CLI, transfer runtime, and self-hostable relay into their public source repository. Removed the private MCP command from the CLI and added public-boundary, package, relay, and container release checks.
