---
"@peardrop/cli": minor
---

Deterministic verification instead of browser ceremony: `peardrop spec check` validates a TOML or inline spec and prints the fields, labels, links, and delivered filenames it will render; `peardrop doctor` reports installations on PATH, Node, Worker reachability, wallet, running receivers, installed-skill freshness, and optional `--store` sink preflights. `--version` is quiet unless a second installation is on PATH. `receive`/`local` print one stderr line when an installed skill copy is older than the running CLI, and `peardrop agent --update` refreshes every recorded install. A "Drop problem" GitHub issue template asks for the JSON stream and `doctor` output.
