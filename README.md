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
npx --yes @peardrop/cli@latest receive --target ./inbox
npx --yes @peardrop/cli@latest <slug> "text to send"
npx --yes @peardrop/cli@latest send <slug> ./file.zip
npx --yes @peardrop/cli@latest test nc
```

Normal CLI sends use direct HyperDHT Noise connections and keep PearDrop infrastructure out of the payload path. Add `--relay` to `send` when you need to force the same WebSocket-to-HyperDHT Relay transport used by the hosted sender; it tries non-custodial Relay first and falls back to custodial forwarding only when required. Pass `--no-relay` to `receive` when you explicitly want a direct-only session.

`test nc` runs a disposable, non-custodial-only production Relay transfer without a browser. It invokes the exact shared web-sender boundary (`sendRelay`) that the hosted browser sender and `send --relay` use — not a CLI subprocess approximation. It verifies the received bytes and hash, receiver shutdown, tunnel consumption, and **terminal consistency**: after any failure, timeout, or signal, it awaits bounded sender teardown and watches the receiver for a 2-second window so no invisible live attempt can deliver after the terminal result. Use `--json` for structured lifecycle output labeled `receiver`/`web-sender`/`relay`/`harness`, or `--timeout 1m` to override the bounded 30-second default.

## Relay

In non-custodial mode the relay forwards opaque handshake and payload bytes without receiving the sender's session key. When a normal sender cannot reach the receiver through that path, it can retry in custodial fallback mode; that mode terminates sender-side encryption at the relay and can inspect bytes in transit, but stores no payload. The selected mode is reported for every transfer. Relay admission requires signed tickets and can report byte usage to a compatible control plane; `test nc` disables fallback so it specifically proves or falsifies the non-custodial path.

```bash
docker build -f infra/relay/Dockerfile -t peardrop-relay .
docker run --rm -p 8080:8080 \
  -e RELAY_TICKET_SECRET=replace-me \
  -e RELAY_API_TOKEN=replace-me \
  -e WORKER_URL=https://peardrop.fyi \
  peardrop-relay
```

See `infra/relay/compose.yaml` for the same setup with Docker Compose.

Turnkey third-party ticket issuance and CLI relay discovery are tracked in [issue #1](https://github.com/smashah/peardrop/issues/1).

## Releases

`@peardrop/core`, `@peardrop/cli`, and the relay image share one version. Bumpy prepares the version PR; merging it publishes npm packages and `ghcr.io/smashah/peardrop-relay:<version>` from the same verified commit.

The package names must exist before npm allows trusted-publisher setup, so the first release uses an authenticated bootstrap and later releases use GitHub OIDC. See [docs/RELEASING.md](./docs/RELEASING.md).
