# Release and novel-path acceptance (maintainers)

This is maintainer material. It is deliberately **not** part of the shipped agent skill: a routine credential drop is proven by `share_ready` and needs no browser ceremony. Use this document only for a new CLI or web release, a transport or lifecycle change, a new field type or rendering surface, or an incident reproduction.

## Minimum gate

1. Record the exact published CLI version (`npx --yes @peardrop/cli@latest --version`), requested mode, target, TTL, PIN state, and expected field count. Validate the installed artifact, not the tag name.
2. Confirm every field's type, required/optional state, validation, label, instructions, scope, and deepest actionable HTTPS link against the source request.
3. Render an identical disposable session in a real browser and verify the exact field count, labels, links, enabled submission, received bytes and hash, receiver exit, and that the consumed URL is unusable. HTTP 200, a fetched bundle, or an SPA shell is not rendering proof.
4. Only after that proof, create a fresh real session. Never open, automate, submit, or consume the real handoff session.
5. Hand over URL, fingerprint, target, expiry, mode, PIN state, requested fields, and post-receipt behaviour.

## Receipt template

```text
CLI version:
Requested mode: hosted | local
Mode-specific command:
Target (directory ends in / when multi-field):
TTL / expiry:
PIN required: yes | no
Expected field count:
Field names, types, and required states:
Provider/account boundary and exclusions:
Rendered field count:
Rendered actionable links:
Submit enabled and exercised on disposable session: yes | no
Disposable received byte count/hash:
Disposable selected transport: hyperdht | relay | local
Disposable Relay mode: non-custodial | custodial-fallback | not-applicable
Disposable receiver exit and public cancellation/consumption result:
Disposable storage hook and per-sink result:
Real session created after proof and untouched: yes | no
Real URL and fingerprint:
```

See [transport-diagnostics.md](transport-diagnostics.md) for the Relay/web-sender invariants and `test nc`.
