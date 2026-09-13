---
"@peardrop/cli": minor
"@peardrop/core": minor
---

Built-in storage sinks: `receive --store` and `local --store` deliver each received value straight into macOS Keychain, Passbolt, 1Password, or a 0600 env file (or `file` to keep the plaintext), remove the plaintext delivery file, emit one value-free `stored` result per sink per field, and append metadata rows to `~/.peardrop/ledger.jsonl`. Sinks are preflighted (including a probe write for Keychain and Passbolt) before a URL is shared or a local server starts. New `peardrop hook test` rehearses sinks and, with `--run-hook`, the on_receive hook against fabricated delivery files, cleaning up after itself. `BridgeServer` accepts `afterReceive`; core exports the sink API.
