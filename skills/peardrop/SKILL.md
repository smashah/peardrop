---
name: peardrop
description: Use PearDrop to receive or send secrets, API keys, credentials, certificates, files, or structured multi-field forms without putting values in chat. Also use when authoring a TOML drop spec or a post-receive storage hook.
---

# PearDrop

Use a current CLI. If `peardrop --version` on PATH prints a version at least as new as the one named at the top of this document, use that bare `peardrop` for every command: it is local code your harness will not block. Otherwise use the published package explicitly:

```bash
npx --yes @peardrop/cli@latest --version
```

Never use an older `peardrop` than that, an unscoped npx package name, a private collector, or an MCP the user did not choose. Harness permission classifiers (Claude Code auto mode among them) often deny `npx` of an external package; a current global install is the reliable path, so when npx is refused ask the human to run `npm install -g @peardrop/cli@latest` once and continue with the bare binary.

`npx --yes @peardrop/cli@latest agent` prints this skill and its references in full. Run `npx --yes @peardrop/cli@latest agent --install` once per machine so the skill loads with your harness next time instead of being fetched; `agent --update` refreshes it after a CLI release.

## Create a drop

This is the only path. Target: a shared URL within 90 seconds of a complete request. No browser check, no disposable session, no wrapper script, no package-source inspection — `share_ready` is the proof that the page works.

1. **Pick the mode.** Hosted `receive` when the sender opens `https://secure.peardrop.fyi/...` from any device (the normal case; relay fallback is already on, do not add `--relay`). `local` only when sender and receiver share one machine and the user asked for a loopback page (`local` takes no `--ttl`, `--name`, or `--relay`). Never swap one for the other silently.
2. **Create and restrict the inbox.** Multi-field targets are directories ending in `/`:

   ```bash
   umask 077 && mkdir -p ./peardrop-inbox/ && chmod 700 ./peardrop-inbox/
   ```

3. **Describe the page.** For a routine drop use inline flags and no file at all (example below). Use a TOML spec (`--spec ./drop.toml`) when the page is reusable or elaborate: several grouped fields, provider scopes, a hook with configuration. `--print-spec` turns any inline drop into that TOML. For multi-field or hooked specs read [references/config-and-handoff.md](references/config-and-handoff.md) first. Preserve the request literally: do not invent fields, do not drop optional ones, and never put a secret value in the spec.
4. **Start the receiver detached.** `--detach` registers the tunnel, prints `session` and `share_ready` (or `share_pending`), then returns while the receiver keeps running in the background; its full event stream is in the log named in the output. Do not block your session on the receiver. A human who wants to watch it live can omit `--detach`.

   ```bash
   npx --yes @peardrop/cli@latest receive --detach --json --target ./peardrop-inbox/ --ttl 15m \
     --title "Share one API token" \
     --request "Create a token for the requested project and permissions only, copy it, paste it below, and select Send." \
     --field api_token:token:"API token" \
     --field-link "api_token=Open the provider console|https://console.example.com/api-tokens" \
     --field-shown-once api_token
   ```

   With a TOML spec instead: `npx --yes @peardrop/cli@latest receive --detach --json --spec ./drop.toml --target ./peardrop-inbox/ --ttl 15m`.

5. **Wait for `share_ready`**, then share its `url` and `fingerprint` immediately. `session` is not readiness. `share_pending` means the Worker has not confirmed yet: keep waiting, or check `npx --yes @peardrop/cli@latest status <slug>`.
6. **Give a short receipt**: CLI version, mode, target, TTL, PIN state, field count, URL, fingerprint, and what happens after receipt.
7. **Follow up later** with `npx --yes @peardrop/cli@latest wait <slug>` (blocks until delivered, expired, or failed and prints the events; `--timeout 30s` to poll) or `status <slug>`; `cancel <slug>` stops the background receiver and tears the page down.

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

Hosted `receive --json` emits `session`, then `share_ready` or `share_pending`, then `connected`, `delivered`, and a terminal `teardown` or `error`. With `--detach` the first two reach your stdout and the rest go to the log (`wait <slug>` replays them). TTL expiry is `teardown` with `status: "expired"` and exit code 0. `local --json` emits `listening` and `closed` (including the hook result). Every event is a compact JSON line on stdout; human diagnostics go to stderr. No event carries owner authority, so the stream is safe to log in full. `session`, `share_ready`, and `share_pending` include `cancelWith`, the exact command that cancels the drop.

A page view, ticket, socket close, attempted send, or sender-side final frame is never delivery; only authenticated receiver acknowledgement completes and consumes the drop. On cancellation, failure, expiry, or a signal the receiver tears the public session down.

## Store received secrets

Prefer built-in sinks over a hand-written hook. `--store` (repeatable) puts each received value straight into the sink and removes the plaintext delivery file; every sink is preflighted before the URL is shared, so a read-only vault folder fails now, not after the human has pasted a live token.

```bash
--store keychain:service=starling.pat,account=me      # macOS Keychain, value via stdin
--store "passbolt:folder=<folder-id>,name=Starling PAT"  # go-passbolt-cli (value on the child's argv for one call)
--store 1password:vault=Personal,item=Starling PAT     # op CLI, value via a 0600 template file
--store env-file:path=./.env,key=STARLING_PAT          # 0600 dotenv line
--store file                                           # keep the plaintext file as well
```

`{field}` in a service, name, item, or key expands to the field name; with several fields each gets its own entry. Do not decide whether a vault is available by looking for its config files: `--store` preflights each sink before the URL exists, and `npx --yes @peardrop/cli@latest doctor --store passbolt` (or any sink spec) checks it on its own. `--store` is repeatable, so one command can feed several sinks. Results arrive as `stored` events (one per sink per field, never with the value) and as value-free rows in `~/.peardrop/ledger.jsonl`. To rehearse without a tunnel: `npx --yes @peardrop/cli@latest hook test --field starling_pat:token --store keychain:service=starling.pat` writes and removes test-suffixed entries and reports each step.

Write an `on_receive` hook (`[hooks] on_receive` or `--on-receive`) only for a destination no sink covers. It reads the `0600` delivery files named by `PEARDROP_FILE_PATHS`; PearDrop never passes values on argv or in the environment. It must report each destination separately, record only metadata, delete plaintext before reporting success, and keep stdout free of secret material. Rehearse it with `hook test --run-hook`. A hook runs after delivery and cannot undo it. Details are in [references/config-and-handoff.md](references/config-and-handoff.md).

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

Deterministic checks replace any browser ceremony:

- `npx --yes @peardrop/cli@latest spec check --spec ./drop.toml` (or the same inline flags) validates the page and prints the exact fields, labels, links, and delivered filenames it will produce.
- `npx --yes @peardrop/cli@latest hook test …` rehearses `--store` sinks and the hook with fake delivery files.
- `npx --yes @peardrop/cli@latest status <slug>` reports the tunnel, the receiver pid, and its last event; `wait <slug>` replays the event log.
- `npx --yes @peardrop/cli@latest doctor` checks installations on PATH, Node, Worker reachability, wallet, running receivers, installed skill freshness, and any `--store` sink you pass.

If `share_ready` never arrives, `status` disagrees with the stream, or delivery fails: keep the JSON stream (it contains no secrets), run `doctor`, and file an issue with both at https://github.com/smashah/peardrop/issues/new?template=drop-problem.yml. Release, transport, and rendering acceptance are maintainer tasks documented in the repository's `docs/`, not in this skill.
