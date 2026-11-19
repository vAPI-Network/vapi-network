# Support

This repository holds the open-source `vapi-network` client: the CLI, the local MCP
server and the SDK. Use the table to find the right place; a question in the right
place gets an answer sooner.

| You have                                         | Go to                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| A bug in the CLI, MCP server, SDK or these docs  | [Open an issue](https://github.com/vAPI-Network/vapi-network/issues/new/choose)   |
| A question about how something works, or an idea | [GitHub Discussions](https://github.com/vAPI-Network/vapi-network/discussions)    |
| A question about your account, points or a quest | [Discord](https://discord.gg/vapinetwork) or [Telegram](https://t.me/vapinetwork) |
| An API you want listed on vAPI Call              | `vapi publish`, described in [docs/call.md](./docs/call.md#publish-an-api)        |
| A vulnerability                                  | security@vapinetwork.ai, as described in [SECURITY.md](./SECURITY.md)             |
| Anything else                                    | hello@vapinetwork.ai                                                              |

## Before you open an issue

1. Update to the latest release. `npm view vapi-network version` prints it and
   `vapi --version` prints yours.
2. Read [docs/troubleshooting.md](./docs/troubleshooting.md). It covers the login,
   vault and secret-store failures reported most often.
3. Search [open and closed issues](https://github.com/vAPI-Network/vapi-network/issues?q=is%3Aissue).

## What to include

Give the client version, the operating system, the Node.js version, the exact
command and the complete message it printed. `vapi report "<what happened>"` collects
the version and environment for you and prints a prefilled issue link. Write in
English when you can; a report in another language is still read.

Never post a recovery phrase, a private key, a vault password, a Router key or an
API key. Maintainers never ask for them. Anyone who does, in an issue, a direct
message or a chat, is not part of vAPI Network.

## What issues are not for

Maintainers cannot look up an account, credit points or review a quest from a public
issue; those requests are closed with a pointer to Discord. Issues that advertise a
service are closed as well: listing an API on vAPI Call is permissionless through
`vapi publish`, and the client carries no provider-specific examples or adapters.
