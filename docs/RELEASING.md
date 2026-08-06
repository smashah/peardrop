# Releasing PearDrop

GitHub Actions and Bumpy own versions, tags, changelogs, npm publication, and the relay image. Do not publish packages or hand-edit versions locally.

## One-time npm setup

In the npm dashboard, configure GitHub Actions trusted publishing for:

| Package | Repository | Workflow |
| --- | --- | --- |
| `peardrop` | `smashah/peardrop` | `.github/workflows/release.yml` |
| `@peardrop/core` | `smashah/peardrop` | `.github/workflows/release.yml` |

The workflow uses npm provenance and does not require a long-lived npm token.

## Release flow

1. Add or update a file under `.bumpy/` in each pull request that changes shipped behavior.
2. Merge the feature pull request into `main` after CI and Bumpy checks pass.
3. Bumpy opens or updates the release pull request.
4. Review and merge the release pull request.
5. The protected `publish` environment runs the full verification suite, publishes npm packages, and pushes matching version and `latest` relay images to GHCR.

A release is complete only when both npm packages, the GitHub release, and `ghcr.io/smashah/peardrop-relay:<version>` exist for the same version.
