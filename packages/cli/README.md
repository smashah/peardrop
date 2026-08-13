# PearDrop CLI

PearDrop creates short-lived file and secret drops. Direct CLI transfers are end-to-end encrypted over HyperDHT Noise connections; Relay transfers report whether they used non-custodial forwarding or custodial fallback.

```bash
npx --yes @peardrop/cli@latest receive --target ./inbox
npx --yes @peardrop/cli@latest silent-moss-7f2 "text to send"
npx --yes @peardrop/cli@latest send silent-moss-7f2 ./file.zip
npx --yes @peardrop/cli@latest test nc
```

Drop links are two words and a short code — `silent-moss-7f2` — so they survive being read aloud or typed from a phone. The slug names a drop; it never authorizes one. The `local` command serves its page on `http://127.0.0.1:<port>/<slug>` while uploads are still gated on a single-use token the page holds, and remote tunnels are still gated on their owner token.

The receiver prints a shareable URL and keeps the private key on the receiving machine. Direct transfers are free, and so are the first 5MB of any relayed transfer; only relay usage past that free tier is metered.

No wallet and no flags are needed to run `receive`. Relay fallback is allowed by default, while the actual transport is reported when a sender connects. Pass `--no-relay` to stay direct-only. Enabling relay never loads a wallet or contacts the payment facilitator on its own — the wallet is used lazily, only once direct P2P did not carry the transfer and relayed bytes trend over the free 5MB tier. At that point, an unconfigured wallet is reported with an actionable message instead of failing the session up front.

Force the hosted WebSocket Relay transport from the CLI with either a text payload or a file:

```bash
npx --yes @peardrop/cli@latest send silent-moss-7f2 --relay --text "text to send"
npx --yes @peardrop/cli@latest send silent-moss-7f2 --relay ./file.zip
```

The forced Relay sender uses the same state machine as the hosted web sender: non-custodial WebSocket-to-HyperDHT first, with custodial forwarding only as a fallback. Add `--verbose` for elapsed phase diagnostics on stderr or `--json` for structured lifecycle events on stdout.

`npx --yes @peardrop/cli@latest test nc` is the production non-custodial diagnostic. It invokes the exact shared web-sender boundary (`sendRelay` from `@peardrop/core/relay`) that the hosted browser drop page, forced `send --relay`, and the relay e2e harness all use — not a CLI subprocess approximation of it. It creates a disposable receiver, forces non-custodial Relay with custodial fallback disabled, verifies byte-for-byte delivery and clean receiver exit, confirms the tunnel was consumed, and deletes its temporary data. After any failure, timeout, SIGINT, or SIGTERM, it awaits bounded sender teardown and then watches the receiver for a documented 2-second terminal-consistency window: if the receiver delivers bytes the sender can no longer see — the invisible-live-attempt-after-failure condition — the diagnostic turns red at `late-delivery` rather than reporting success from eventual byte delivery. Events are labeled `receiver`, `web-sender`, `relay`, or `harness`. Its default timeout is 30 seconds; override it with a bounded duration such as `--timeout 1m`, and add `--json` for stable machine-readable events and the final summary.

`--json` prints one compact JSON line per event on stdout: the session (with the drop URL and relay fallback permission), the accepted connection's actual transport details, and the delivered file metadata. A startup failure emits `{"mode":"remote","event":"error","error":"…"}` and exits non-zero. Every line is flushed as it is written, and a successful one-time receiver exits after its delivery acknowledgement is flushed. Direct CLI sends also report descriptor lookup, payload preparation, DHT connection, transfer, and total timings so network discovery time is visible instead of being folded into one delivery duration.

To pay for relay usage above the free tier, configure a local Base wallet:

```bash
npx --yes @peardrop/cli@latest wallet configure 0xYOUR_PRIVATE_KEY
npx --yes @peardrop/cli@latest wallet status
```

The private key is stored locally with mode `0600` and is redacted from command output. When production facilitator discovery does not report compatible Base mainnet support, PearDrop stays direct-only.

## TOML drop-page specs

The `local` command renders a fixed single-paste page by default. Pass `--spec <file.toml>` or `--spec-inline '<toml>'` to shape the page instead: multiple named fields, per-field validation, and copy overrides. A malformed or invalid spec fails immediately with a clear error and a non-zero exit code — no server is started.

```bash
npx --yes @peardrop/cli@latest local --target ./inbox/ --spec ./drop.toml
npx --yes @peardrop/cli@latest local --target ./inbox/ --spec-inline 'title = "Drop your key"

[[fields]]
name = "api_key"
type = "secret"
required = true'
```

### Schema

```toml
# Page shape (all optional)
title = "Rotate the deploy key"
description = "This replaces the key used by the release pipeline."

# Copy overrides (all optional — sensible defaults ship for each)
[copy]
request = "Paste the new deploy key below."
success = "Deploy key rotated — pipeline will pick it up on the next run."
failure = "Rotation failed — check the value and try again."

# Post-receive hook (optional) — see "Post-receive hooks" below.
[hooks]
on_receive = "./scripts/store-deploy-key.sh"

# One [[fields]] entry per field on the page, rendered in declaration order.
[[fields]]
name = "deploy_key"        # required, unique within the spec — also the delivered filename
type = "secret"            # secret | text | file | token
label = "Deploy Key"       # optional, defaults to `name`
description = "Rotate it at https://console.example.com/keys if it's expired."  # optional — see "Description and link text" below
link = { label = "Open the console", url = "https://console.example.com/keys" } # optional, https:// only — renders as its own clickable button, separate from description
required = true            # optional, defaults to true
masked = true               # optional; secret/token default to masked, text/file ignore it
placeholder = "sk-..."      # optional, text/secret/token only
minLength = 20              # optional, text/secret/token only
maxLength = 200             # optional, text/secret/token only
format = "^sk-[A-Za-z0-9]+$" # optional regex, text/secret/token only
count = 1                   # optional, file fields only — exact number of files expected
message = "Custom error"    # optional — overrides every default validation message for this field
```

**Field types:** `text` (plain input), `secret`/`token` (masked input by default), `file` (file picker; set `count` for multi-file fields).

**Description and link text — both render markdown, not plain text.** The top-level `description`, `copy.request`, and each field's own `description` all support markdown (headings, lists, bold, inline code, links) and auto-linkify a bare `http://`/`https://` URL even without markdown link syntax — you don't need `[text](url)` for a URL to become clickable, just write it in prose. Raw HTML is stripped, not rendered, so this is safe for untrusted spec text. `link` (the structured field above) is a separate, distinct affordance — it always renders as its own clickable button, has a required `https://` scheme, and is meant for "the one place to go for this," while a `description` with a URL in it is meant for "here's some context, which happens to include a link." Use whichever affordance fits the sentence you're writing, or both.

**Quantity:** a page can declare any number of `[[fields]]`. A spec that can produce more than one delivered file (more than one field, or a single `file` field with `count > 1`) requires a directory target (`--target` ending in `/`) — the `local` command checks this before starting the server.

**Validation defaults** (each overridable per-field via `message`): required → `"This field is required."`; length → `"Must be at least/at most N characters."`; format → `"This value doesn't match the expected format."`; file count → `"Expected exactly N files."`. Validation runs client-side (in the rendered page) and again server-side on submit; a failing submission re-renders the form with field-level messages and **does not** consume the single-use drop link, so retries work. Nothing is written to disk until every field passes.

**Delivered filenames:** `text`/`secret`/`token` fields land as `<name>.txt`; `file` fields land as `<name>-<original filename>` (or `<name>-<index>-<original filename>` when `count > 1`).

**No spec:** `local` without `--spec`/`--spec-inline` keeps today's single paste-or-drop-a-file page.

The same spec format is accepted by peardrop.fyi's agent-facing tool for programmatic, agent-driven sessions.

## Post-receive hooks

A drop can run a command once the payload is confirmed written to disk — for example to load the delivered secret into a Keychain entry and append a ledger row, instead of a caller polling the target path.

```bash
npx --yes @peardrop/cli@latest local --target ./inbox/ --on-receive ./scripts/store-deploy-key.sh
npx --yes @peardrop/cli@latest receive --target ./inbox/ --on-receive ./scripts/store-deploy-key.sh
```

The same command can live in the spec as `[hooks] on_receive`, and `--on-receive` overrides it when both are given. An empty command is rejected before the server starts.

**The hook is told about the drop through the environment, never through argv:**

| Variable | Value |
| --- | --- |
| `PEARDROP_TARGET_PATH` | The resolved absolute target path the drop was written to. |
| `PEARDROP_FILE_PATHS` | Newline-separated absolute paths of the files this drop delivered. |
| `PEARDROP_FILE_COUNT` | How many files this drop delivered. |

The raw secret value is never passed to the hook at all — not on argv, not in the environment. The hook reads it from the file PearDrop already wrote with mode `0600`, so a secret never becomes visible to `ps` or to any other user's process listing. Delivered filenames are reduced to their basename with control characters stripped, so a sender cannot forge extra `PEARDROP_FILE_PATHS` lines.

The command runs through a shell (so ordinary shell syntax works) with its stdout and stderr forwarded to PearDrop's **stderr**, keeping `--json` output on stdout parseable.

**A hook is a side effect, not part of the delivery.** It runs only after the write is confirmed and the sender has been told the drop landed, so a non-zero exit never un-writes an already-delivered secret. The failure is logged to stderr, and `local --json` reports it on the closing line:

```json
{"mode":"local","event":"closed","status":"delivered","target":"./inbox/","pid":123,"hook":{"ok":false,"exitCode":7,"signal":null}}
```

The session stays open until the hook exits, so a `local --json` consumer that waits for the `closed` line knows the hook has finished.

See [peardrop.fyi](https://peardrop.fyi) and the [source repository](https://github.com/smashah/peardrop) for the protocol, security model, relay, and full command reference.
