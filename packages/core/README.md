# `@vapi-network/core`

The non-custodial heart of [vAPI Network](https://github.com/vAPI-Network/vapi-network):
the x402 protocol, the wallet store, spend policy, the network guard, discovery
merge and the append-only receipt ledger. Keys stay on the caller's machine.
This package proxies no payment and sends no telemetry.

Two entry points:

- `@vapi-network/core` — everything an agent-driven surface may use: accounts,
  balances, `WalletStore`, `SpendPolicy`, `resolvePassphrase`, receipts, stats
  and the x402 primitives.
- `@vapi-network/core/secrets` — human-only. `exportRecoveryPhrase`,
  `exportKeystoreKeys`, `createKeystoreWithPhrase` and `decryptPrivateKey`
  return a recovery phrase or a private key, so they are deliberately not
  re-exported from the main index and the MCP package is forbidden to import
  them.

See the [root README](https://github.com/vAPI-Network/vapi-network#readme) for
the SDK examples, the configuration layout and the custody model.
