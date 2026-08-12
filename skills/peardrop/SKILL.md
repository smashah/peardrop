---
name: peardrop
description: Use PearDrop when the user needs to upload a file, secret, key, certificate, or other sensitive input without pasting it into chat.
---

# PearDrop

When you need a file or secret from the user, run:

```bash
npx --yes @peardrop/cli@latest receive --target <destination-path> --json
```

Keep the process running, then send the returned upload URL and fingerprint to the user. State the destination path clearly. Wait for delivery before continuing.

Never ask the user to paste secret contents into chat. Never echo received secrets into logs or the transcript. Validate the received file's type and structure before using it.

Use `npx --yes @peardrop/cli@latest local --target <destination-path>` when the user and agent share the same machine and network transit is unnecessary.
