---
name: peardrop
description: Use PearDrop to receive or send secrets, API keys, credentials, certificates, files, or structured multi-field forms without putting values in chat. Also use when authoring a TOML drop spec or a post-receive storage hook.
---

# PearDrop

Always use the published CLI:

```bash
npx --yes @peardrop/cli@latest --version
```

Never substitute a remembered global binary, an unscoped npx package name, a private collector, or an MCP the user did not choose. `npx --yes @peardrop/cli@latest agent` prints this skill and its references in full; `agent --install` copies them into your skill directories.

## Create a drop

This is the only path. Target: a shared URL within 90 seconds of a complete request. No browser check, no disposable session, no wrapper script, no package-source inspection — `share_ready` is the proof that the page works.

1. **Pick the mode.** Hosted `receive` when the sender opens `https://secure.peardrop.fyi/...` from any device (the normal case; relay fallback is already on, do not add `--relay`). `local` only when sender and receiver share one machine and the user asked for a loopback page (`local` takes no `--ttl`, `--name`, or `--relay`). Never swap one for the other silently.
2. **Create and restrict the inbox.** Multi-field targets are directories ending in `/`:

   ```bash
   umask 077 && mkdir -p ./peardrop-inbox/ && chmod 700 ./peardrop-inbox/
   ```

3. **Describe the page.** For a routine drop use inline flags and no file at all (example below). Use a TOML spec (`--spec ./drop.toml`) when the page is reusable or elaborate: several grouped fields, provider scopes, a hook with configuration. `--print-spec` turns any inline drop into that TOML. For multi-field or hooked specs read [references/config-and-handoff.md](references/config-and-handoff.md) first. Preserve the request literally: do not invent fields, do not drop optional ones, and never put a secret value in the spec.
4. **Start the receiver and keep it alive until a terminal event.** In an agent harness run it as a background task whose stdout you can read back; a human runs it in a terminal.

   ```bash
   npx --yes @peardrop/cli@latest receive --target ./peardrop-inbox/ --ttl 15m --json \
     --title "Share one API token" \
     --request "Create a token for the requested project and permissions only, copy it, paste it below, and select Send." \
     --field api_token:token:"API token" \
     --field-link "api_token=Open the provider console|https://console.example.com/api-tokens" \
     --field-shown-once api_token
   ```

   With a TOML spec instead: `npx --yes @peardrop/cli@latest receive --spec ./drop.toml --target ./peardrop-inbox/ --ttl 15m --json`.

5. **Wait for `share_ready`**, then share its `url` and `fingerprint` immediately. `session` is not readiness. `share_pending` means the Worker has not confirmed yet: keep waiting, or check `npx --yes @peardrop/cli@latest status <slug>`.
6. **Give a short receipt**: CLI version, mode, target, TTL, PIN state, field count, URL, fingerprint, and what happens after receipt.

Do not scan the Keychain, a vault, or the environment for existing values before creating a drop; it is never needed and harness classifiers block it. Ledgers, persistence, and issue filing happen after the URL is shared, never on the way to it.

### Worked example: one API token as a TOML spec

The same page as the inline command above, as a reusable file. The heredoc is byte-identical to [examples/api-token.toml](https://github.com/smashah/peardrop/blob/main/examples/api-token.toml). Replace the console URL and the project/permission wording with the actual request.

```bash
umask 077
mkdir -p ./peardrop-inbox/
chmod 700 ./peardrop-inbox/
cat > ./drop.toml <<'TOML'
title = "Share one API token"
description = "Create a token for the requested project and permissions only."

[copy]
request = """
1. Open the provider console using the button below.
2. Select the requested project and create a token with only the requested permissions.
3. Copy the token, paste it below, and select Send.
"""

[[fields]]
name = "api_token"
type = "token"
label = "API token"
description = "Paste the token from the provider console. Never put it in chat."
link = { label = "Open the provider console", url = "https://console.example.com/api-tokens" }
required = true
masked = true
TOML
npx --yes @peardrop/cli@latest receive --spec ./drop.toml --target ./peardrop-inbox/ --ttl 15m --json
```

## Events

Hosted `receive --json` emits `session`, then `share_ready` or `share_pending`, then `connected`, `delivered`, and a terminal `teardown` or `error`. TTL expiry is `teardown` with `status: "expired"` and exit code 0. `local --json` emits `listening` and `closed` (including the hook result). Every event is a compact JSON line on stdout; human diagnostics go to stderr. No event carries owner authority, so the stream is safe to log in full. `session`, `share_ready`, and `share_pending` include `cancelWith`, the exact command that cancels the drop.

A page view, ticket, socket close, attempted send, or sender-side final frame is never delivery; only authenticated receiver acknowledgement completes and consumes the drop. On cancellation, failure, expiry, or a signal the receiver tears the public session down.

## Store received secrets

Use `[hooks] on_receive` (or `--on-receive`) when receipt must populate a Keychain, vault, or ledger. The hook reads the `0600` delivery files named by `PEARDROP_FILE_PATHS`; PearDrop never passes values on argv or in the environment. The hook must resolve its runtime portably, write each sink and report each result separately, record only metadata in ledgers, delete the plaintext before reporting success, and keep stdout free of secret material. A hook runs after delivery and cannot undo it: treat hook failure as a storage failure, not a transfer failure. Details and a hook contract are in [references/config-and-handoff.md](references/config-and-handoff.md).

## Send

```bash
npx --yes @peardrop/cli@latest <slug> "text to send"
npx --yes @peardrop/cli@latest send <slug> ./file.zip
```

Report the transport the CLI actually selected. Direct HyperDHT and non-custodial Relay keep payloads opaque to PearDrop; `custodial-fallback` can inspect bytes in transit even though it stores nothing, so never describe every Relay transfer as end-to-end encrypted.

## Never

- Ask the user to paste a secret into chat, or print values, owner tokens, tickets, private keys, or received contents. Validate file structure without echoing it.
- Share a URL from any event other than `share_ready`.
- Add verification ceremony to a routine drop.

## When something is wrong

If `share_ready` never arrives, `npx --yes @peardrop/cli@latest status <slug>` disagrees with the stream, or delivery fails: keep the JSON stream (it contains no secrets), run `npx --yes @peardrop/cli@latest --version`, and file an issue at https://github.com/smashah/peardrop/issues with both. Release, transport, and rendering acceptance are maintainer tasks documented in the repository's `docs/`, not in this skill.
