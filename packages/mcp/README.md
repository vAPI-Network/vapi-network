# `@vapi-network/mcp`

The stdio MCP server behind `vapi mcp`: namespaced tools that let an agent
search the vAPI catalogue, read a listing's request contract, pay an x402 API
from a local wallet, and read balances and receipts. It never creates, renames,
removes, backs up or exports a wallet, and no tool of its returns a recovery
phrase, a private key or a passphrase.

One entry point, `@vapi-network/mcp`, exporting `createVapiServer`,
`startStdioServer`, `loadServerConfig`, `WalletSession` and the individual
`callService`, `inspectService`, `searchMarketplace` and `getWallet` tools.

See the [root README](https://github.com/vAPI-Network/vapi-network#readme) for
the editor configuration, the full tool table and the deprecated aliases.
