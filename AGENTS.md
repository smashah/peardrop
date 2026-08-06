# PearDrop public repository

This repository owns PearDrop's public protocol/runtime, CLI, and relay. Public code must never import private `peardrop.fyi` source, Git dependencies, generated private files, or paths outside this repository.

- Use strict TypeScript and preserve the existing package boundaries.
- Add a Bumpy entry for every user-visible package change.
- Run `pnpm run boundary:check`, type checks, tests, builds, package smoke checks, and the relay container build before release.
- Keep hosted account logic, MCP code, credentials, and production deployment settings out of this repository.
- Before finishing a changed session, run `~/projects/ALFRED/scripts/log-work.sh` and record the concrete outcome.
