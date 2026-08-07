---
'@peardrop/core': patch
'@peardrop/cli': patch
'@peardrop/relay': patch
---

The bridge drop pages drop the green-on-dark identity for a monochrome one.

Both inline pages `peardrop local` serves — the Mode 3 local render and the remote-mode spec render — were dark navy with emerald accents. They now share one `DROP_PAGE_STYLES` block restating the webapp's tokens: near-black on white, square corners, hairline rules, no gradient, glow, or shadow, plus a true-neutral `prefers-color-scheme: dark` inversion. Sharing the block is what keeps the two pages consistent, since a Node-rendered page can't import the webapp's stylesheet.

Both pages also carried Tailwind class names with no Tailwind runtime behind them, so markup like `bg-emerald-500` and the `status.className = 'text-red-400'` assignments styled nothing; status messages now use `is-error` / `is-done` classes that actually exist. The file input was marked `class="hidden"` with no matching rule, which left a stray native file input visible under the drop zone — it now uses the HTML `hidden` attribute.
