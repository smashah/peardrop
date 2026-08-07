---
'@peardrop/core': minor
'@peardrop/cli': minor
'@peardrop/relay': minor
---

Drop links are now readable words — `http://127.0.0.1:61236/jolly-flame-tds` instead of a raw token or a base32 blob.

`generateSlug()` returns two words and a three-character Crockford base32 code (`silent-moss-7f2`) from one shared corpus in `@peardrop/core`, replacing the 26-character base32 string. Local drops (`peardrop local`, `peardrop send --browser`) serve the drop page on `/<slug>` instead of `/#<token>`, so the single-use upload token no longer travels in the URL where a shell history, a screenshot, or a pasted link would carry it (#16).

The slug is a display and routing identifier, never an authorisation: uploads still have to present the 128-bit single-use token, and remote tunnels still turn on the unchanged HMAC owner-token scheme. The page now receives that token in its body, so the bridge drops its wildcard CORS header, marks the page `Cache-Control: no-store`, and — when bound to loopback — refuses requests arriving under a hostname it doesn't recognise, which closes the DNS-rebinding path to a local drop.

`peardrop local --json` gains a `slug` field alongside `url`. `generateUniqueSlug(isTaken)` is exported for stores that must keep slugs unique: at 2^29 slugs, allocation needs a check-and-retry loop rather than a single draw.
