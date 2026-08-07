---
'@peardrop/core': minor
'@peardrop/cli': minor
'@peardrop/relay': minor
---

Relay transfers are now free up to 5MB, and `peardrop receive` no longer needs a wallet to start.

`calculateRelayFee`'s free threshold moved from `0` bytes to 5MB, with the existing schedule shifted above it (`5MB–50MB = $0.01`, `50MB–500MB = $0.02`, then the unchanged variable rate) and every boundary exposed as a named constant.

`--allow-relay` (still on by default) is a policy flag again: it no longer signs a payment authorization at session creation, so a receiver with no wallet starts normally instead of hard-failing before any transfer exists. The wallet is loaded lazily — only once the Worker reports relayed bytes trending over the free tier — and a missing wallet is reported there with an actionable message (#17).
