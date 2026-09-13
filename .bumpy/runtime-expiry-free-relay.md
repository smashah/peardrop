---
"@peardrop/cli": patch
"@peardrop/core": patch
---

Hosted receivers now stop at their advertised TTL, including while waiting for readiness or a sender and during direct or relay transfers. JSON output emits one terminal `teardown` event with `status: "expired"`, `reason: "ttl-expired"`, and `expiresAt`, without owner authority. Expiry saves the local session as expired and exits with status 0; successful delivery and cancellation retain their existing outcomes. Invalid, zero, negative, or overflowing TTL values are rejected before registration; durations require a positive whole number followed by `s`, `m`, `h`, or `d`.

The shared relay sender accepts free-tier tickets with `billingScheme: "disabled"` as well as paid `"upto"` tickets, and continues rejecting unknown schemes.
