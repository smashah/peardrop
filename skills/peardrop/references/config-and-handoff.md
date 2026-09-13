# Structured drop configuration and handoff

Use this reference whenever a drop has more than one field, provider-specific instructions, credential scopes, or a storage hook. Routine single-token drops do not need it: the worked example in SKILL.md is enough.

## Author the spec from the request

Build a field inventory before writing TOML. For each requested value, record its stable name, type, label, required state, validation, group, source link, scope, and whether the provider shows it once. Preserve the request literally: do not add plausible fields such as VAT, omit address components, or turn an optional value into a required one.

Field rules:

- The complete field type set is `text`, `secret`, `token`, and `file`. `secret` and `token` are masked by default. Use `text` for ordinary names, addresses, bank details, identifiers, and enumerated answers; do not mask them merely because the page is sensitive.
- `required` defaults to `true`, so write `required = false` for every genuinely optional field. An optional field may be blank; never instruct the sender to enter `-` or `N/A`.
- `placeholder`, `minLength`, `maxLength`, and `format` apply only to `text`, `secret`, and `token`. Use `count` only with `file` to constrain how many files the field accepts. Do not attach an accepted-but-ignored validation key to the wrong type.
- Apply validation only when the source requirement supports it. Do not apply a generic eight-character secret rule to a six-digit sort code. Use `message` only to replace the matching validation error with precise, non-secret guidance; it does not create a new constraint.
- PearDrop currently has no `select` or `multiselect` field type. Until the product supports them, use a text field whose label and description list the exact allowed values; never leave the options implicit.
- Use `[[groups]]` for related fields from one provider surface. A field belongs to at most one group, and its `group` must name a declared group.
- `allOrNothing = true` controls whether an incomplete group is reported as outstanding or partial. It does not make optional fields required and does not independently block submission.
- Use a directory target ending in `/` whenever the spec can deliver multiple files. Each field becomes its own delivered file.

## Make the page self-sufficient

The sender should not need a second chat message to understand the task. Put these facts on the page itself:

- what is being requested and why;
- the exact provider account, project, environment, or zone boundary;
- exact permissions or scopes and explicit exclusions;
- the deepest available provider URL that creates or reveals the value;
- the destination and post-receive storage behavior;
- a precise success and failure outcome.

Use structured `link` metadata for the primary HTTPS action. Use `scope` for provider permission names, `resource_name` for the suggested provider-side name, `shown_once` for unrecoverable values, and `entry_url` only for a read-only URL that the sender must carry into the provider. `entry_url` is never a submitted input.

## Generic credential example

```toml
title = "Create the deployment token"
description = "Create this in the named service account only. Do not grant billing, membership, token-management, or unrelated-account access."

[copy]
request = "Create the scoped token using the link below, then paste the value shown once. It will be stored in the approved vault and the plaintext delivery file will be removed."
success = "Received by PearDrop. The receiver will now run the configured storage hook."
failure = "The value was not accepted. Keep this page open and follow the field error."

[hooks]
on_receive = "./scripts/store-delivered-secret.sh"

[[fields]]
name = "deploy_token"
type = "token"
label = "Service-account deployment token"
description = "Use the separate service account named in this request. Copy the token before leaving the provider page."
link = { label = "Create the scoped token", url = "https://console.example.com/account/api-tokens" }
scope = ["Deployments: Edit", "Resources: Edit", "Account settings: Read"]
resource_name = "project-production-deployer"
shown_once = true
required = true
masked = true
minLength = 20
```

For a multi-field form, declare the shared provider context once and keep field semantics exact:

```toml
[[groups]]
name = "bank_account"
title = "Payout bank account"
description = "Enter the account that should receive payouts."
allOrNothing = true

[[fields]]
name = "bank_name"
type = "text"
label = "Bank name"
group = "bank_account"
required = false

[[fields]]
name = "sort_code"
type = "text"
label = "Sort code (six digits)"
group = "bank_account"
placeholder = "00-00-00"
format = "^[0-9]{2}-?[0-9]{2}-?[0-9]{2}$"
required = false

[[fields]]
name = "preferred_payment_method"
type = "text"
label = "Preferred payment method (Bank transfer, cheque, or gift card)"
description = "Enter exactly one of: Bank transfer, cheque, gift card."
required = false
```

For the recurring grouped-provider-OAuth shape (one console link, a redirect URI the sender carries to that provider, explicit scopes, a suggested resource name, a masked shown-once secret), see [`examples/google-oauth-client.toml`](../../../examples/google-oauth-client.toml), reproduced verbatim in [SKILL.md](../SKILL.md).

## Hook contract

Use a small wrapper script as `on_receive`; do not put a secret value in the TOML command. If the hook uses Bun, resolve it in this order: `PEARDROP_BUN`, `BUN`, then `bun` on `PATH`. Never hard-code `/opt/homebrew/bin/bun`, a user home path, or another machine-specific runtime location.

The hook receives:

- `PEARDROP_TARGET_PATH`: resolved target;
- `PEARDROP_FILE_PATHS`: newline-separated delivery files;
- `PEARDROP_FILE_COUNT`: delivered file count.

For each file, the hook reads the value from disk, writes only the approved sinks, records ledger metadata without the value, deletes the plaintext, and only then reports per-sink outcomes. Never pass the value on argv, place it in process logs, or collapse several sink results into one ambiguous success.

## Worked example: grouped provider OAuth credential

The recurring shape a single-field example does not cover: one provider console, a redirect URI the sender must carry to that console, explicit scopes, a suggested resource name, and a masked shown-once secret. This is [examples/google-oauth-client.toml](https://github.com/smashah/peardrop/blob/main/examples/google-oauth-client.toml) verbatim; `scripts/check-skill-example.mjs` fails CI if this copy drifts.

```toml
# examples/google-oauth-client.toml
title = "Create the Google OAuth client"
description = "Create this in the named GCP project only. Do not grant access to other projects or shared credentials."

[copy]
request = "Create the OAuth client using the link below, then paste the client ID and the client secret shown once. They will be stored in the approved vault and the plaintext delivery files will be removed."
success = "Received by PearDrop. The receiver will now run the configured storage hook."
failure = "The value was not accepted. Keep this page open and follow the field error."

[hooks]
on_receive = "./scripts/store-delivered-secret.sh"

[[groups]]
name = "google_oauth_client"
title = "Google OAuth client"
description = "Create a new OAuth 2.0 Client ID in the example-project GCP project using the redirect URI, suggested client name, and scopes shown below."
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
