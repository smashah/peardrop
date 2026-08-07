# Changelog





## 1.3.0
<sub>2026-08-07</sub>

- [#27](https://github.com/smashah/peardrop/pull/27) [`c195ed2`](https://github.com/smashah/peardrop/commit/c195ed2d76f4ad639598f47a74ae62be7b2582e2)  *(minor)*
  Drop links are now readable words — `http://127.0.0.1:61236/jolly-flame-tds` instead of a raw token or a base32 blob.

  `generateSlug()` returns two words and a three-character Crockford base32 code (`silent-moss-7f2`) from one shared corpus in `@peardrop/core`, replacing the 26-character base32 string. Local drops (`peardrop local`, `peardrop send --browser`) serve the drop page on `/<slug>` instead of `/#<token>`, so the single-use upload token no longer travels in the URL where a shell history, a screenshot, or a pasted link would carry it ([#16](https://github.com/smashah/peardrop/issues/16)).

  The slug is a display and routing identifier, never an authorisation: uploads still have to present the 128-bit single-use token, and remote tunnels still turn on the unchanged HMAC owner-token scheme. The page now receives that token in its body, so the bridge drops its wildcard CORS header, marks the page `Cache-Control: no-store`, and — when bound to loopback — refuses requests arriving under a hostname it doesn't recognise, which closes the DNS-rebinding path to a local drop.

  `peardrop local --json` gains a `slug` field alongside `url`. `generateUniqueSlug(isTaken)` is exported for stores that must keep slugs unique: at 2^29 slugs, allocation needs a check-and-retry loop rather than a single draw.
- [#28](https://github.com/smashah/peardrop/pull/28) [`fed1da9`](https://github.com/smashah/peardrop/commit/fed1da9590b077558240edc844e29392afb42f12)  *(minor)*
  `receive` takes `--spec`/`--spec-inline`, so a remote drop page can be as self-explanatory as a local one.

  Until now only `local` could read a TOML drop-page spec, which meant every remote drop was a generic "paste something" box with no title, no description and no field labels — the mode most people actually use from a phone ([#26](https://github.com/smashah/peardrop/issues/26)). `receive --spec <file>` and `receive --spec-inline '<toml>'` now parse and validate the spec before the Worker is ever asked for a tunnel, exactly the way `local` validates before it starts a server, and send the parsed spec with the tunnel registration so peardrop.fyi can render the page it describes. A spec's `[hooks] on_receive` is honoured too, with `--on-receive` still overriding it.

  `@peardrop/core` gains `decodeDropSpec`, which validates an already-parsed spec object — the JSON form the Worker receives — against the same schema, defaults and duplicate/regex rules `parseDropSpecToml` applies to TOML text, so both ends judge a spec identically.

## 1.2.1
<sub>2026-08-07</sub>

- [#23](https://github.com/smashah/peardrop/pull/23) [`64178a2`](https://github.com/smashah/peardrop/commit/64178a23a3bbe4d397f88236230dc1a355bff0c9)  *(patch)*
  The bridge drop pages drop the green-on-dark identity for a monochrome one.

  Both inline pages `peardrop local` serves — the Mode 3 local render and the remote-mode spec render — were dark navy with emerald accents. They now share one `DROP_PAGE_STYLES` block restating the webapp's tokens: near-black on white, square corners, hairline rules, no gradient, glow, or shadow, plus a true-neutral `prefers-color-scheme: dark` inversion. Sharing the block is what keeps the two pages consistent, since a Node-rendered page can't import the webapp's stylesheet.

  Both pages also carried Tailwind class names with no Tailwind runtime behind them, so markup like `bg-emerald-500` and the `status.className = 'text-red-400'` assignments styled nothing; status messages now use `is-error` / `is-done` classes that actually exist. The file input was marked `class="hidden"` with no matching rule, which left a stray native file input visible under the drop zone — it now uses the HTML `hidden` attribute.
- [#25](https://github.com/smashah/peardrop/pull/25) [`fbfd2c3`](https://github.com/smashah/peardrop/commit/fbfd2c3fa6a12d6390a9b21340f9eb1beadafb91)  *(patch)*
  Relay is named honestly as the default path, and `receive --json` can no longer leave a consumer with nothing to parse.

  `--allow-relay` read as something you opt into even though it defaulted to `true`. It is replaced by `--relay`/`--no-relay`, so the documented surface matches the shipped behaviour: relay is on unless you pass `--no-relay`. `--allow-relay` and `--no-allow-relay` still parse as a hidden alias, so scripts written against 1.2.0 keep working ([#22](https://github.com/smashah/peardrop/issues/22)).

  `receive --json` now emits one compact, flushed JSON line per event on stdout — the session with its drop URL, or `{"mode":"remote","event":"error","error":"…"}` with a non-zero exit when the session cannot start. Previously a failing session printed oclif's human-shaped prose to stderr and nothing parseable to stdout, and the session line itself was pretty-printed and unflushed, so a piped agent could lose it entirely.

## 1.2.0
<sub>2026-08-07</sub>

- [#20](https://github.com/smashah/peardrop/pull/20) [`bd24274`](https://github.com/smashah/peardrop/commit/bd24274a33f511fe6c034a324943461d5616b220)  *(minor)*
  Relay transfers are now free up to 5MB, and `peardrop receive` no longer needs a wallet to start.

  `calculateRelayFee`'s free threshold moved from `0` bytes to 5MB, with the existing schedule shifted above it (`5MB–50MB = $0.01`, `50MB–500MB = $0.02`, then the unchanged variable rate) and every boundary exposed as a named constant.

  `--allow-relay` (still on by default) is a policy flag again: it no longer signs a payment authorization at session creation, so a receiver with no wallet starts normally instead of hard-failing before any transfer exists. The wallet is loaded lazily — only once the Worker reports relayed bytes trending over the free tier — and a missing wallet is reported there with an actionable message ([#17](https://github.com/smashah/peardrop/issues/17)).
- [#18](https://github.com/smashah/peardrop/pull/18) [`9a64f6c`](https://github.com/smashah/peardrop/commit/9a64f6c1934cbbbb649514aeb87e854c94a98e17)  *(minor)*
  Drops can now run a command once the payload is confirmed written: `[hooks] on_receive` in a TOML spec, or `--on-receive <command>` on `peardrop local` and `peardrop receive` (the flag overrides the spec). The hook is told about the drop through `PEARDROP_TARGET_PATH`, `PEARDROP_FILE_PATHS`, and `PEARDROP_FILE_COUNT` — never on argv, and the raw secret value is never passed at all, so nothing sensitive reaches a process listing. A non-zero hook exit is logged to stderr and reported on `local --json`'s closing line, but never un-writes the delivered secret ([#8](https://github.com/smashah/peardrop/issues/8)).

  Delivered filenames now have control characters stripped alongside the existing basename reduction, so a sender-chosen name cannot forge entries in the newline-separated `PEARDROP_FILE_PATHS`.

## 1.1.0
<sub>2026-08-07</sub>

- [#3](https://github.com/smashah/peardrop/pull/3) [`239fd97`](https://github.com/smashah/peardrop/commit/239fd97d2ee2ba307191b8e87c044dc3818332d4)  *(minor)*
  `peardrop local` gained `--spec`/`--spec-inline` TOML drop-page specs: multiple named fields (secret/text/file/token), per-field validation, and copy overrides, with client- and server-side validation and a resubmittable single-use link on failure (peardrop.fyi#15).

  Also fixed `peardrop local` buffering its Drop URL / `--json` output behind un-awaited writes, so piped or backgrounded runs (how agents drive it) could see zero bytes for a long time. `--json` now emits compact single-line JSON, and SIGINT/SIGTERM exit cleanly with a session summary ([#2](https://github.com/smashah/peardrop/issues/2)).
- [`0c1ff99`](https://github.com/smashah/peardrop/commit/0c1ff99f91bf6aceb2a8fd36714c778ecd70c918)  *(patch)*
  Moved the PearDrop CLI, transfer runtime, and self-hostable relay into their public source repository. Removed the private MCP command from the CLI and added public-boundary, package, relay, and container release checks.

## 1.0.1
<sub>2026-08-06</sub>

- [#10](https://github.com/smashah/peardrop.fyi/pull/10) [`c2c356b`](https://github.com/smashah/peardrop.fyi/commit/c2c356b882f13fefb844eb6aa7bd5bc1f6ff737f)  *(patch)*
  Hardened PearDrop's secure transfer and release foundation, including explicit relay authorization controls and Effect-managed transfer lifecycles.
