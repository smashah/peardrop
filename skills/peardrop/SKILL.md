---
name: peardrop
description: Use PearDrop to receive or send sensitive files, secrets, credentials, API keys, certificates, structured multi-field forms, or other private input without putting values in chat. Also use when choosing Local versus hosted Relay mode, authoring a TOML drop spec, configuring post-receive storage hooks, validating a real handoff, or diagnosing PearDrop transport and lifecycle behavior.
---

# PearDrop

Use the published CLI explicitly for every operator command:

```bash
npx --yes @peardrop/cli@latest --version
```

Never substitute a remembered global binary, `npx peardrop`, a private collector, or a newly enabled MCP. Use an already-approved PearDrop MCP only when the user explicitly chose that surface; otherwise use the CLI.

## Choose the mode before creating the drop

- Use hosted receiving when the sender opens `https://secure.peardrop.fyi/...` from another device. Relay fallback is already allowed by default; do not add `--relay` to `receive` as if it were an opt-in.
- Use `local` only when the sender and receiver share the same machine and the user requested a loopback page. Do not pass receive-only flags such as `--ttl`, `--name`, or `--relay` to `local`.
- Never silently replace Local with hosted receiving, hosted receiving with Local, or PearDrop with another collector.

For one file or one unstructured value:

```bash
npx --yes @peardrop/cli@latest receive --target ./quarantine/input.bin --json
```

For a structured or multi-field drop, read [references/config-and-handoff.md](references/config-and-handoff.md) before writing the spec. Multi-field targets must be explicit directories ending in `/`:

```bash
npx --yes @peardrop/cli@latest receive --spec ./drop.toml --target ./peardrop-inbox/ --ttl 15m --json
```

The Local equivalent is:

```bash
npx --yes @peardrop/cli@latest local --spec ./drop.toml --target ./peardrop-inbox/ --json
```

Keep the process alive. In JSON mode, parse the `session`, `connected`, and `delivered` events from stdout; human diagnostics belong on stderr. A successful one-use receiver exits after receiver-confirmed delivery. Before delivery it intentionally waits until delivery, TTL expiry, cancellation, or a signal.

## Do not hand over an unproved page

Before sending the real URL, complete the handoff receipt in [references/config-and-handoff.md](references/config-and-handoff.md). The minimum gate is:

1. Record the exact published CLI version, requested mode, target, TTL, PIN state, and expected field count.
2. Confirm every field's type, required/optional state, validation, label, instructions, scope, and deepest actionable HTTPS link against the source request. Do not invent or omit fields.
3. Render an identical disposable session and verify the exact field count, labels, links, enabled submission, received bytes, receiver exit, and consumed URL. HTTP 200 or an SPA shell is not rendering proof.
4. Create a fresh real session after the disposable proof. Never automate, submit, or consume the real handoff session.
5. Give the user the URL, fingerprint, target, expiry, mode, PIN state, requested fields, and what happens after receipt.

Never ask the user to paste a secret into chat. Never print values, raw errors containing values, owner tokens, tickets, private keys, or received secret contents. Validate file structure without echoing it.

## Store received secrets deliberately

Use a spec `[hooks] on_receive` command when receipt must populate a Keychain, vault, or metadata ledger. The hook reads the `0600` delivery files named by `PEARDROP_FILE_PATHS`; PearDrop never passes raw values on argv or in the environment. The hook must:

- resolve its runtime portably rather than hard-coding a machine-specific executable path;
- write each approved sink and report each sink's result separately;
- record metadata only in ledgers;
- delete plaintext before reporting success;
- keep stdout free of secret material.

A hook runs after delivery and cannot undo it. Treat hook failure as a separate storage failure, not as proof the transfer failed.

## Send and diagnose

Send text with the positional shorthand or a file with `send`:

```bash
npx --yes @peardrop/cli@latest <slug> "text to send"
npx --yes @peardrop/cli@latest send <slug> ./file.zip
```

Force the hosted web Relay state machine when that path is the subject of the test:

```bash
npx --yes @peardrop/cli@latest send <slug> --relay --text "text to send" --verbose
npx --yes @peardrop/cli@latest test nc --verbose --timeout 30s
```

`test nc` is disposable and non-custodial-only; it does not replace acceptance of the rendered public page. Read [references/transport-diagnostics.md](references/transport-diagnostics.md) before debugging or releasing the Relay/web sender.

Report the actual selected transport and Relay mode. Direct HyperDHT and non-custodial Relay keep payloads opaque to PearDrop infrastructure. `custodial-fallback` can inspect bytes in transit even though it does not store them, so never describe every Relay transfer as end-to-end encrypted.

On cancellation, failure, TTL expiry, or signal, ensure the receiver tears down the public session. A page view, ticket, socket close, attempted send, or sender-side final frame is never delivery; only authenticated receiver acknowledgement may complete and consume the drop.
