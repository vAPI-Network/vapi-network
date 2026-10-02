# Router

Router and staking commands plus the Router client are covered here; see [README.md](../README.md).

| Command                                       | Options                                                  | What it does                                                |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| `vapi router models`                          | `--wallet <name>`                                        | Lists the vAPI Router model ids                             |
| `vapi router usage`                           | `--wallet <name>`                                        | Shows the agent's Compute allowance and Router balance      |
| `vapi router chat --model <id> "<prompt>"`    | `--system <text>`, `--max-tokens <n>`, `--wallet <name>` | Sends one chat request through vAPI Router                  |
| `vapi router key`                             | `--rotate`, `--wallet <name>`                            | Prints a gated Router key or rotates it without printing it |
| `vapi router buy <1\|5\|20\|50>`              | `--wallet <name>`, `--json`                              | Buys vAPI Router balance with USDC from your wallet         |
| `vapi router buy --auto <tier> --below <usd>` | `--wallet <name>`, or use `--auto off`                   | Sets or clears automatic vAPI Router balance refill         |
| `vapi stake status`                           | `--wallet <name>`                                        | Shows the linked owner's stake and Compute today            |
| `vapi stake open`                             | `--wallet <name>`, `--no-browser`                        | Prints and optionally opens the staking page                |

`await vapi.router.openai()` returns the vAPI Router base URL and key for an
OpenAI-compatible framework. Use this in your own code. Do not pass it into a
model prompt.

Bought vAPI Router balance never expires and is used after the daily Compute
allowance runs out. Your wallet's client spend caps apply to every purchase,
including automatic refill.
