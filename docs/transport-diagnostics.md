# Transport diagnostics and release invariants

Use this reference when PearDrop itself is being diagnosed, tested, released, or deployed. Routine credential collection does not need these internals.

## Exercise the correct boundary

```bash
npx --yes @peardrop/cli@latest test nc --verbose --timeout 30s
```

`test nc` must invoke the shared `sendRelay` state machine used by the hosted web sender and forced `send --relay`, not a fast CLI-to-CLI approximation. Its disposable run must label receiver, web-sender, relay, and harness events with monotonic phase timings; verify exact bytes, hash, sender exit, receiver exit, and tunnel consumption; then remove its data and session.

Use a rendered public-page acceptance separately when the hosted UI changed. A green CLI diagnostic cannot prove that the deployed page loaded its CSS/JavaScript, rendered the spec, or wired the shared sender correctly.

## Preserve terminal consistency

Only authenticated receiver acknowledgement establishes delivery, completion, and one-use consumption. Page views, relay tickets, sender writes, socket close, `final=true`, HTTP 404, or attempted sends cannot establish delivery.

After a sender failure, timeout, signal, or fallback decision:

1. Cancel the active attempt and await its file-reader, peer, DHT, and WebSocket teardown.
2. Start fallback only after attempt-one teardown completes.
3. Watch the receiver for the documented two-second terminal-consistency window.
4. Turn the diagnostic red if the abandoned attempt delivers late.
5. Cancel the disposable tunnel and verify the public page/ticket is unusable on every outcome.

Test concurrent late usage/accounting writes against consumption. A stale final report must not revive a consumed or cancelled tunnel.

## Detect no progress instead of waiting blindly

The browser-preferred non-custodial attempt uses a five-second no-progress watchdog reset only by real Relay protocol frames. Real progress extends the attempt. Silence or a deterministic pre-ACCEPT connection failure triggers fallback after complete teardown. Receiver rejection and failures after receiver ACCEPT remain terminal; do not silently weaken security by falling back on every error.

Report the actual mode:

- `non-custodial`: Relay forwards opaque handshake/payload bytes without the sender session key;
- `custodial-fallback`: Relay terminates sender-side encryption and can inspect bytes in transit, but stores no payload.

Never label fallback permission as the selected transport or claim all Relay transfers are end-to-end encrypted.

## Prove relay health and identity

Health must describe the data plane, not merely an HTTP process:

- expose starting, healthy, and unhealthy from real DHT bind/bootstrap state;
- use an observed startup grace rather than an arbitrary short timeout;
- include build/source/image identity in release evidence;
- induce and verify a negative health state;
- treat inability to fetch health as unknown, not proof that Relay is unavailable.

Bind Worker, web assets, Relay image, npm packages, and the tested source commit explicitly before promotion. A live 200 or an `@latest` label is not artifact identity.

## Keep DHT lookup symmetric

The receiver announces the default hashed HyperDHT target. Sender discovery must use the same hashing semantics; do not override `findPeer` with `hash: false` for a receiver public key. Cover announce/find symmetry in the non-custodial diagnostic.

## Receiver lifecycle

Human mode must show waiting, connection, selected transport/mode, delivery, and teardown. JSON stdout must contain stable machine-readable `session`, `connected`, `delivered`, and error events without human chatter; verbose diagnostics go to stderr.

The receiver remains alive before delivery, then exits zero after acknowledged one-time delivery. Signals, explicit cancellation, TTL expiry, and failed diagnostics must perform bounded control-plane cancellation so a dead receiver never leaves a live-looking credential page.
