# `@vapi-network/cli`

The command implementations behind the `vapi` binary of
[vAPI Network](https://github.com/vAPI-Network/vapi-network): wallet management,
discovery, payment, receipts, the OS secret store and the MCP launcher. The
wallet key stays encrypted on the local machine and every x402 payment is signed
locally.

The `vapi docs`, `vapi docs search` and `vapi docs read` commands access the
public documentation without a wallet, account or payment.

`vapi init`, `vapi wallet create <name>` and `vapi mcp install <claude|cursor|codex>`
offer to link the wallet to your vAPI dashboard in an interactive terminal.
Use `--no-link` to skip the prompt. Non-interactive and JSON runs return a login
hint, and a failed link leaves wallet creation or MCP installation successful.
`vapi dashboard [--account <name>] [--no-browser] [--json]` opens or prints
My agents and offers to link an unlinked account.

Two entry points: `@vapi-network/cli` exports `runCli` and the `HELP` text for
embedding, and `@vapi-network/cli/cli` is the executable itself.

Most users should install or run the unscoped `vapi-network` package instead.

## Exports

| Name              | What it is                                                                                                                                                                                                                                                           | Since            |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CliDependencies` | type CliDependencies = { fetchImpl?: typeof fetch; prompts?: CliPrompts; interactive?: boolean; env?: NodeJS.ProcessEnv; secretStore?: SecretStore; now?: () => Date; agentLink?: { startDeviceLink?: typeof startDeviceLink; pollDeviceLink?: typeof pollDeviceL... | 0.5.0 or earlier |
| `CliIo`           | type CliIo = { stdout(message: string): void; stderr(message: string): void; }                                                                                                                                                                                       | 0.5.0 or earlier |
| `HELP`            | constant HELP: CLI usage, commands and options, including dashboard linking and `--no-link`.                                                                                                                                                                         | 0.5.0 or earlier |
| `runCli`          | function (argv = process.argv.slice(2), io: CliIo = processIo, dependencies: CliDependencies = {}): Promise<number>                                                                                                                                                  | 0.5.0 or earlier |

See the [root README](https://github.com/vAPI-Network/vapi-network/blob/main/README.md#cli-reference) for the full command reference.
