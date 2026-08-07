# PearDrop CLI

PearDrop creates short-lived, end-to-end encrypted file and secret drops over HyperDHT Noise connections.

```bash
npx @peardrop/cli receive --target ./inbox
npx @peardrop/cli send https://peardrop.fyi/<slug> ./file.zip
```

The receiver prints a shareable URL and keeps the private key on the receiving machine. Direct transfers are free, and so are the first 5MB of any relayed transfer; only relay usage past that free tier is metered.

No wallet is needed to run `peardrop receive`. `--allow-relay` (on by default) is a policy flag: it permits the relay fallback but never loads a wallet or contacts the payment facilitator on its own. The wallet is used lazily — only once direct P2P did not carry the transfer and relayed bytes trend over the free 5MB tier. At that point, an unconfigured wallet is reported with an actionable message instead of failing the session up front.

To pay for relay usage above the free tier, configure a local Base wallet:

```bash
peardrop wallet configure 0xYOUR_PRIVATE_KEY
peardrop wallet status
```

The private key is stored locally with mode `0600` and is redacted from command output. When production facilitator discovery does not report compatible Base mainnet support, PearDrop stays direct-only.

## TOML drop-page specs

`peardrop local` renders a fixed single-paste page by default. Pass `--spec <file.toml>` or `--spec-inline '<toml>'` to shape the page instead: multiple named fields, per-field validation, and copy overrides. A malformed or invalid spec fails immediately with a clear error and a non-zero exit code — no server is started.

```bash
peardrop local --target ./inbox/ --spec ./drop.toml
peardrop local --target ./inbox/ --spec-inline 'title = "Drop your key"

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

**Quantity:** a page can declare any number of `[[fields]]`. A spec that can produce more than one delivered file (more than one field, or a single `file` field with `count > 1`) requires a directory target (`--target` ending in `/`) — `peardrop local` checks this before starting the server.

**Validation defaults** (each overridable per-field via `message`): required → `"This field is required."`; length → `"Must be at least/at most N characters."`; format → `"This value doesn't match the expected format."`; file count → `"Expected exactly N files."`. Validation runs client-side (in the rendered page) and again server-side on submit; a failing submission re-renders the form with field-level messages and **does not** consume the single-use drop link, so retries work. Nothing is written to disk until every field passes.

**Delivered filenames:** `text`/`secret`/`token` fields land as `<name>.txt`; `file` fields land as `<name>-<original filename>` (or `<name>-<index>-<original filename>` when `count > 1`).

**No spec:** `peardrop local` without `--spec`/`--spec-inline` keeps today's single paste-or-drop-a-file page.

The same spec format is accepted by peardrop.fyi's agent-facing tool for programmatic, agent-driven sessions.

## Post-receive hooks

A drop can run a command once the payload is confirmed written to disk — for example to load the delivered secret into a Keychain entry and append a ledger row, instead of a caller polling the target path.

```bash
peardrop local --target ./inbox/ --on-receive ./scripts/store-deploy-key.sh
peardrop receive --target ./inbox/ --on-receive ./scripts/store-deploy-key.sh
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

**A hook is a side effect, not part of the delivery.** It runs only after the write is confirmed and the sender has been told the drop landed, so a non-zero exit never un-writes an already-delivered secret. The failure is logged to stderr, and `peardrop local --json` reports it on the closing line:

```json
{"mode":"local","event":"closed","status":"delivered","target":"./inbox/","pid":123,"hook":{"ok":false,"exitCode":7,"signal":null}}
```

The session stays open until the hook exits, so a `local --json` consumer that waits for the `closed` line knows the hook has finished.

See [peardrop.fyi](https://peardrop.fyi) and the [source repository](https://github.com/smashah/peardrop) for the protocol, security model, relay, and full command reference.
