# Releasing PearDrop

GitHub Actions and Bumpy own versions, tags, changelogs, npm publication, and the relay image. Do not publish packages or hand-edit versions locally.

## Bootstrap npm packages

Trusted publishing can only be configured after a package exists. Confirm both package names are available and that the publishing account owns their scope, then run the full local checks and publish the exact `1.0.1` tarballs produced by `pnpm run package:smoke` using an authenticated npm session.

After both bootstrap packages exist, configure GitHub Actions trusted publishing in each npm package's settings:

| Package | Repository | Workflow filename | Environment |
| --- | --- | --- | --- |
| `@peardrop/cli` | `smashah/peardrop` | `release.yml` | `publish` |
| `@peardrop/core` | `smashah/peardrop` | `release.yml` | `publish` |

Create and protect the GitHub `publish` environment, restrict it to `main`, and require approval. The workflow uses npm provenance and does not require a long-lived npm token after bootstrap.

## Release flow

1. Add or update a file under `.bumpy/` in each pull request that changes shipped behavior.
2. Merge the feature pull request into `main` after CI and Bumpy checks pass.
3. Bumpy opens or updates the release pull request.
4. Review and merge the release pull request.
5. The protected `publish` environment runs the full verification suite, pushes the versioned relay image, publishes npm packages, verifies npm and GitHub release records, records the immutable image digest, and only then promotes the relay image to `latest`.

The first automated release is the pending fixed `1.0.2` release. It is complete only when both npm packages, the GitHub release, and `ghcr.io/smashah/peardrop-relay:<version>@sha256:...` exist for the same version.
