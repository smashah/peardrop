---
"@peardrop/cli": minor
"@peardrop/core": minor
---

`receive` and `local` accept the drop page inline: `--title`, `--description`, `--request`, `--success`, `--failure`, repeatable `--field name:type[:label]`, and per-field `--field-link`, `--field-description`, `--field-scope`, `--field-resource-name`, `--field-entry-url`, `--field-placeholder`, `--field-format`, `--field-min-length`, `--field-max-length`, `--field-count`, `--field-message`, `--field-optional`, `--field-shown-once`, `--field-unmasked`. A routine one-token drop no longer needs a TOML file. `--print-spec` prints the equivalent TOML (for any spec source) and exits, so an inline drop can be promoted to a reusable `--spec`. Core exports `stringifyDropSpecToml`.
