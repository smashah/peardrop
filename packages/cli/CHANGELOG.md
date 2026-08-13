# Changelog















## 1.5.6
<sub>2026-08-13</sub>

- [#65](https://github.com/smashah/peardrop/pull/65) [`4ebec15`](https://github.com/smashah/peardrop/commit/4ebec1570ca20fba9f73bcf150eaca22aad7d955)  *(patch)*
  Bundled the guarded relay handshake runtime into published browser and CLI artifacts so duplicate Noise frames after handshake completion cannot re-enter the completed state machine.

## 1.5.5
<sub>2026-08-13</sub>

- *(patch)* Version bump from group with `@peardrop/core` v1.5.5, `@peardrop/relay` v1.5.5

## 1.5.4
<sub>2026-08-13</sub>

- *(patch)* Version bump from group with `@peardrop/relay` v1.5.4

## 1.5.3
<sub>2026-08-13</sub>

- [#59](https://github.com/smashah/peardrop/pull/59) [`e647ed4`](https://github.com/smashah/peardrop/commit/e647ed44c2bea594e37719bc26c38dca584a0c51)  *(patch)*
  `test nc` now invokes the exact shared web-sender boundary (`sendRelay` from `@peardrop/core/relay`) that the hosted browser drop page, forced `send --relay`, and the relay e2e harness all use — it no longer spawns a CLI subprocess approximation of the protocol. After any failure, timeout, SIGINT, or SIGTERM, the diagnostic awaits bounded sender teardown and then watches the receiver for a documented 2-second terminal-consistency window; if the receiver delivers bytes the sender can no longer see — the invisible-live-attempt-after-failure condition behind the reported `dusky-nectar-yz7` Brand Store incident — the diagnostic turns red at `late-delivery` instead of reporting success from eventual byte delivery. Events are labeled `receiver`, `web-sender`, `relay`, or `harness` with monotonic phase timings. The on-receive hook now exports `resolveBunFromEnv` and documents that hooks always execute through the shell (`shell: true`) so Bun is resolved from `$PATH` (`PEARDROP_BUN` > `BUN` > bare `bun`) and never hardcoded to a machine-specific absolute path.

## 1.5.2
<sub>2026-08-12</sub>

- [#57](https://github.com/smashah/peardrop/pull/57) [`ffa3518`](https://github.com/smashah/peardrop/commit/ffa3518e245922cabab6426f9f55ea83a1c12232)  *(patch)*
  PearDrop now accepts `peardrop <slug> <text>` as the default send form, labels relay as fallback permission instead of the selected transport, reports the actual connection plus direct-transfer phase timings, emits structured connection and delivery events, and exits the one-time receiver after its acknowledged delivery. Forced `send --relay` transfers now share the hosted sender's non-custodial-first Relay state machine, and `test nc` performs a disposable non-custodial production diagnostic with exact byte, hash, lifecycle, cleanup, and tunnel-consumption checks.

## 1.5.1
<sub>2026-08-12</sub>

- [#53](https://github.com/smashah/peardrop/pull/53) [`705379f`](https://github.com/smashah/peardrop/commit/705379f2a236482c4db1076effee0b9246a9dbb1)  *(patch)*
  `peardrop local --spec` now emits its browser program through a raw template and executes that program in regression coverage, proving three fields and their links render. Previously template-literal escaping corrupted the inline script, leaving a 200 page with no fields and no usable submit action.

## 1.5.0
<sub>2026-08-10</sub>

- *(minor)* Version bump from group with `@peardrop/core` v1.5.0

## 1.4.2
<sub>2026-08-10</sub>

- [#38](https://github.com/smashah/peardrop/pull/38) [`66b4e7a`](https://github.com/smashah/peardrop/commit/66b4e7acd1daade13a711792aa6d5a74e1ba8720)  *(patch)*
  `peardrop receive --relay` now tears its own tunnel down when interrupted with Ctrl-C or `kill <pid>` (SIGINT/SIGTERM), the same Worker cancellation `peardrop cancel` already performs. Previously, ending a session any way other than running `peardrop cancel` afterward left the drop page answering HTTP 200 — looking fully live — with no receiver actually listening, until the tunnel's TTL expired on its own.

## 1.4.1
<sub>2026-08-09</sub>

- *(patch)* Version bump from group with `@peardrop/core` v1.4.1

## 1.4.0
<sub>2026-08-08</sub>

- [#30](https://github.com/smashah/peardrop/pull/30) [`2090925`](https://github.com/smashah/peardrop/commit/209092525fa84c1508d61f4b66bbc63f130633eb)  *(minor)* - Per-field link + description on FieldSpec, partial-submission outstanding fields (peardrop.fyi#47)

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
