# Router

Router and Stake are live on production. Router provides hosted inference at `router.vapinetwork.ai`, with OpenAI-compatible requests and an Anthropic-compatible `/v1/messages` endpoint with prompt-cache pricing. Staking vAPI earns a daily Router allowance called Compute, with reviewer eligibility for Tasks later. See [README.md](../README.md).

| Command                                       | Options                                                   | What it does                                                |
| --------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| `vapi router models`                          | `--account <name>`                                        | Lists the vAPI Router model ids                             |
| `vapi router usage`                           | `--account <name>`                                        | Shows the agent's Compute allowance and Router balance      |
| `vapi router chat --model <id> "<prompt>"`    | `--system <text>`, `--max-tokens <n>`, `--account <name>` | Sends one chat request through vAPI Router                  |
| `vapi router key`                             | `--rotate`, `--account <name>`                            | Prints a gated Router key or rotates it without printing it |
| `vapi router buy <1\|5\|20\|50>`              | `--account <name>`, `--json`                              | Buys vAPI Router balance with USDC from your wallet         |
| `vapi router buy --auto <tier> --below <usd>` | `--account <name>`, or use `--auto off`                   | Sets or clears automatic vAPI Router balance refill         |
| `vapi stake status`                           | `--account <name>`                                        | Shows the linked owner's stake and Compute today            |
| `vapi stake open`                             | `--account <name>`, `--no-browser`                        | Prints and optionally opens the staking page                |

`await vapi.router.openai()` returns the vAPI Router base URL and key for an
OpenAI-compatible framework. Use this in your own code. Do not pass it into a
model prompt.

Bought vAPI Router balance never expires and is used after the daily Compute
allowance runs out. Your wallet's client spend caps apply to every purchase,
including automatic refill.
