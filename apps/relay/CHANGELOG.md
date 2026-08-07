# Changelog

## 1.1.0
<sub>2026-08-07</sub>

- [#3](https://github.com/smashah/peardrop/pull/3) [`239fd97`](https://github.com/smashah/peardrop/commit/239fd97d2ee2ba307191b8e87c044dc3818332d4)  *(minor)*
  `peardrop local` gained `--spec`/`--spec-inline` TOML drop-page specs: multiple named fields (secret/text/file/token), per-field validation, and copy overrides, with client- and server-side validation and a resubmittable single-use link on failure (peardrop.fyi#15).

  Also fixed `peardrop local` buffering its Drop URL / `--json` output behind un-awaited writes, so piped or backgrounded runs (how agents drive it) could see zero bytes for a long time. `--json` now emits compact single-line JSON, and SIGINT/SIGTERM exit cleanly with a session summary ([#2](https://github.com/smashah/peardrop/issues/2)).
- [`0c1ff99`](https://github.com/smashah/peardrop/commit/0c1ff99f91bf6aceb2a8fd36714c778ecd70c918)  *(patch)*
  Moved the PearDrop CLI, transfer runtime, and self-hostable relay into their public source repository. Removed the private MCP command from the CLI and added public-boundary, package, relay, and container release checks.
