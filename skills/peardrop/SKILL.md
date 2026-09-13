---
name: peardrop
description: Use PearDrop to receive or send sensitive files, secrets, credentials, API keys, certificates, structured multi-field forms, or other private input without putting values in chat. Also use when choosing Local versus hosted Relay mode, authoring a TOML drop spec, configuring post-receive storage hooks, validating a real handoff, or diagnosing PearDrop transport and lifecycle behavior.
---

# PearDrop

Use the published CLI explicitly for every operator command:

```bash
npx --yes @peardrop/cli@latest --version
```

`--version` also identifies the invoked executable and other PATH installations on stderr. If a bare command rejects a documented flag, use the explicit current invocation above and correct the stale installation or PATH separately. No installation probes run on the receiver path.

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

Keep the process alive. Hosted `receive --json` emits `session`, then a bounded internal readiness check, then either `share_ready` or `share_pending`, then `connected`, `delivered`, and terminal `teardown` or `error`. **`share_ready` is the share gate: never hand the URL to the sender from any other event.** `share_pending` means the Worker has not yet confirmed the tunnel within the bounded wait; the receiver keeps running — wait and re-check `GET /api/tunnels/<slug>` rather than sharing early. Local `local --json` instead emits `listening` and `closed`, including the hook result when a hook ran. Human diagnostics belong on stderr. A successful one-use receiver exits after receiver-confirmed delivery; before delivery it intentionally waits until delivery, TTL expiry, cancellation, or a signal.

No event carries owner authority any more — the JSON stream is safe to log and retain in full. `session`, `share_ready`, and `share_pending` include `cancelWith` (`peardrop cancel <slug>`); the receiver's own 0600 session file on disk is what makes that command work, not anything printed to stdout.

## Do not hand over an unproved page

Never ask the user to paste a secret into chat. Never print values, raw errors containing values, owner tokens, tickets, private keys, or received secret contents. Validate file structure without echoing it.

Acceptance has two tiers. Pick the tier before you start the receiver, not after.

### Tier 1 — routine credential inbox

Applies when the CLI version and page schema are already qualified and only the declarative content (title, fields, links, copy) varies — the normal case for an ordinary credential or secret inbox. **Tier 1 does not require an automated browser check, disposable transfer, package-source inspection, or bespoke wrapper.** Target: under 90 seconds from a complete request to a shared URL.

1. Create the target directory and restrict it before starting the receiver. Multi-field targets end in `/`:

   ```bash
   mkdir -p ./peardrop-inbox/ && chmod 700 ./peardrop-inbox/
   ```

2. Write the spec — from the worked example below when the shape matches, otherwise from [references/config-and-handoff.md](references/config-and-handoff.md).
3. Start the receiver in the foreground, in its own long-lived pane (see the foreground-supervision recipe below).
4. Wait for `share_ready` on stdout. Do not share on `session` — the tunnel may not be resolvable yet.
5. Share the URL immediately once `share_ready` arrives.
6. Everything else — persistence, issue filing, ledger and bookkeeping work — happens *after* the URL is shared, never on the minting path.

Give the user a short receipt: CLI version, mode, target, TTL, PIN state, expected field count, and the `share_ready` URL and fingerprint.

### Tier 2 — release or novel-path acceptance

Scope: a new CLI or web release; a transport or lifecycle change; a new field type or rendering surface; an incident reproduction; or any handoff whose risk owner asks for full acceptance.

Complete the full handoff receipt in [references/config-and-handoff.md](references/config-and-handoff.md). The minimum gate is:

1. Record the exact published CLI version, requested mode, target, TTL, PIN state, and expected field count.
2. Confirm every field's type, required/optional state, validation, label, instructions, scope, and deepest actionable HTTPS link against the source request. Do not invent or omit fields.
3. Render an identical disposable session and verify the exact field count, labels, links, enabled submission, received bytes, receiver exit, and consumed URL. HTTP 200 or an SPA shell is not rendering proof.
4. Create a fresh real session after the disposable proof. Never automate, submit, or consume the real handoff session.
5. Give the user the URL, fingerprint, target, expiry, mode, PIN state, requested fields, and what happens after receipt.

### Foreground-supervision recipe

`--detach` is unavailable — background receiver supervision is not implemented (#88). One canonical pattern instead: the receiver owns a dedicated pane for its own lifetime; the agent reads its stdout from that pane; cleanup is `peardrop cancel <slug>` or Ctrl-C, both of which tear the Worker record down. Never background the receiver with `&` or `nohup` and lose its stdout — that is exactly the supervision `--detach` refuses to fake.

### Worked example: one API token

Start with this minimal hosted spec when the request is one token with setup instructions. Replace the example console URL and the project/permission wording with the actual request; do not put the token into the spec. The heredoc is byte-identical to [examples/api-token.toml](https://github.com/smashah/peardrop/blob/main/examples/api-token.toml), and `scripts/check-skill-example.mjs` checks it against both this skill and the CLI README.

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

Run that command in the foreground, wait for `share_ready`, and share its URL and fingerprint immediately. Keep the session alive until it reports a terminal result. The numbered setup instructions and provider-console button are part of the spec, so no private helper or browser ceremony is needed for this qualified shape.

### Worked example: grouped provider OAuth credential

The recurring shape a plain single-field example doesn't cover: one provider console, a redirect URI the sender must carry to that console, explicit scopes, a suggested resource name, and a masked shown-once secret. This is `examples/google-oauth-client.toml` verbatim — `scripts/check-skill-example.mjs` fails CI if this copy drifts from that file.

```toml
title = "Create the Google OAuth client"
description = "Create this in the named GCP project only. Do not grant access to other projects or shared credentials."

[copy]
request = "Create the OAuth client using the link below, then paste the client ID and the client secret shown once. They will be stored in the approved vault and the plaintext delivery files will be removed."
success = "Received by PearDrop. The receiver will now run the configured storage hook."
failure = "The value was not accepted. Keep this page open and follow the field error."

[hooks]
on_receive = "./scripts/store-delivered-secret.sh"

# The hosted secure.peardrop.fyi renderer does not yet render entry_url,
# resource_name, or scope (smashah/peardrop.fyi#191) — it silently omits all
# three. So the exact redirect URI, suggested client name, and scopes are
# duplicated into this group's description as plain text too, or a sender on
# that renderer sees copy telling them to use "the exact callback shown
# below" with no callback visible. Remove this duplication once #191 lands;
# the structured fields below already render correctly on the local bridge.
[[groups]]
name = "google_oauth_client"
title = "Google OAuth client"
description = "Create a new OAuth 2.0 Client ID in the example-project GCP project. Authorized redirect URI: https://example.com/auth/google/callback — Suggested client name: example-project-production — Scopes: openid, email, profile."
link = { label = "Create OAuth client credentials", url = "https://console.cloud.google.com/apis/credentials" }
allOrNothing = true

[[fields]]
name = "client_id"
type = "text"
label = "OAuth client ID"
description = "Copy the client ID shown after creating the credential."
group = "google_oauth_client"
entry_url = "https://example.com/auth/google/callback"
resource_name = "example-project-production"
scope = ["openid", "email", "profile"]
required = true
format = "^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$"

[[fields]]
name = "client_secret"
type = "secret"
label = "OAuth client secret"
description = "Shown once at creation time — copy it before leaving the provider page."
group = "google_oauth_client"
shown_once = true
required = true
masked = true
minLength = 20
```

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
