# PearDrop

PearDrop provides a secure CLI and a self-hostable relay for short-lived, end-to-end encrypted file and secret transfers.

## Give this to your agent

```text
Read https://raw.githubusercontent.com/smashah/peardrop/main/AGENT_INSTRUCTIONS.md and use PearDrop whenever you need me to upload a file or secret.
```

Your agent will start a receiver, give you a short-lived upload link, wait for delivery, and verify the received file without exposing its contents in chat.

**Agent instructions:** [AGENT_INSTRUCTIONS.md](./AGENT_INSTRUCTIONS.md) · **Installable skill:** [`skills/peardrop/SKILL.md`](./skills/peardrop/SKILL.md)

## What is public here

- `packages/core` owns the PDWP transfer protocol, encryption, relay tickets, Node transport, storage, and session runtime.
- `packages/cli` publishes the `peardrop` command-line client.
- `apps/relay` runs the metered WebSocket-to-HyperDHT relay.
- `infra/relay` contains the public container and self-host examples.

The hosted website, control plane, MCP integration, account logic, billing adapters, credentials, and production deployment configuration live in the private `peardrop.fyi` product repository. This repository never imports their source.

## Development

```bash
pnpm install
pnpm run boundary:check
pnpm run check-types
pnpm run test
pnpm run build
pnpm run package:smoke
```

## CLI

```bash
npx peardrop receive --target ./inbox
npx peardrop send https://peardrop.fyi/<slug> ./file.zip
```

Direct transfers use HyperDHT Noise connections and keep PearDrop infrastructure out of the payload path.

## Relay

The relay forwards opaque ciphertext and does not store payloads. It requires signed relay tickets and can report byte usage to a compatible control plane.

```bash
docker build -f infra/relay/Dockerfile -t peardrop-relay .
docker run --rm -p 8080:8080 \
  -e RELAY_TICKET_SECRET=replace-me \
  -e RELAY_API_TOKEN=replace-me \
  -e WORKER_URL=https://peardrop.fyi \
  peardrop-relay
```

See `infra/relay/compose.yaml` for the same setup with Docker Compose.

## Releases

`@peardrop/core`, the `peardrop` CLI, and the relay image share one version. Bumpy prepares the version PR; merging it publishes npm packages and `ghcr.io/smashah/peardrop-relay:<version>` from the same verified commit.

Before the first npm release, authorize this repository as the trusted publisher for both npm packages. See [docs/RELEASING.md](./docs/RELEASING.md).
