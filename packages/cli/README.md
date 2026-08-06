# PearDrop CLI

PearDrop creates short-lived, end-to-end encrypted file and secret drops over HyperDHT Noise connections.

```bash
npx peardrop receive --target ./inbox
npx peardrop send https://peardrop.fyi/<slug> ./file.zip
```

The receiver prints a shareable URL and keeps the private key on the receiving machine. Direct transfers are free; the optional browser relay is metered and is enabled only when its payment facilitator and relay are available.

The tunnel creator authorizes the optional paid relay from a local Base wallet:

```bash
peardrop wallet configure 0xYOUR_PRIVATE_KEY
peardrop wallet status
```

The private key is stored locally with mode `0600` and is redacted from command output. Without a configured wallet—or when production facilitator discovery does not report compatible Base mainnet support—PearDrop stays direct-only.

See [peardrop.fyi](https://peardrop.fyi) and the [source repository](https://github.com/smashah/peardrop) for the protocol, security model, relay, and full command reference.
