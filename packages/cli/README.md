# `@vapi-network/cli`

The command implementations behind the `vapi` binary of
[vAPI Network](https://github.com/vAPI-Network/vapi-network): wallet management,
discovery, payment, receipts, the OS secret store and the MCP launcher. The
wallet key stays encrypted on the local machine and every x402 payment is signed
locally.

Two entry points: `@vapi-network/cli` exports `runCli` and the `HELP` text for
embedding, and `@vapi-network/cli/cli` is the executable itself.

Most users should install or run the unscoped `vapi-network` package instead.
See the [root README](https://github.com/vAPI-Network/vapi-network#readme) for
the full command reference.
