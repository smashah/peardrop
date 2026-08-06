# PearDrop agent instructions

Use PearDrop whenever you need the user to provide a file, secret, signing key, environment file, certificate, or other sensitive input.

## Receive an upload

1. Choose the exact destination path before starting. Use a temporary quarantine directory when the file is untrusted.
2. Run:

   ```bash
   npx peardrop receive --target <destination-path> --json
   ```

3. Keep the receiver process running. Read the JSON output and send the returned `url` and `fingerprint` to the user.
4. Tell the user where the upload will land, but never ask them to paste the file contents into chat.
5. Wait for PearDrop to report successful delivery.
6. Validate the file type and structure before using or executing it. Never print secret contents back into the transcript.

Received files are written with restrictive permissions. The transfer is end-to-end encrypted; PearDrop relays opaque ciphertext when direct peer-to-peer transport is unavailable.

## Send a file

```bash
npx peardrop send <peardrop-url-or-slug> <file-path>
```

For an interactive local browser surface:

```bash
npx peardrop send <peardrop-url-or-slug> --browser
```

## Local-only receiving

When the agent and user share the same machine, avoid network transit:

```bash
npx peardrop local --target <destination-path>
```

Give the user the localhost URL and keep the process running until delivery completes.
