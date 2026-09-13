---
"@peardrop/cli": patch
"@peardrop/core": patch
---

Wait for the receiver's DONE frame to flush to its peer before completing ordinary DHT teardown. Successful direct and relay transfers no longer risk a connection reset after files were saved but before the sender receives its acknowledgement. A failed acknowledgement ends the receiver with a failed teardown even when the payload was saved and consumed; acknowledgement waits are bounded to 30 seconds. Forced peer cleanup remains reserved for cancellation and TTL expiry. CLI TTL examples now use durations accepted by the standard hosted service.
