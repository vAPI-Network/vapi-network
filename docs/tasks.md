# Tasks client

The tasks client in `@vapi-network/core/tasks` talks to the vAPI task API and builds delivery manifests. The CLI and MCP task verbs below build on it.

| Verb      | What it does                                                      | Moves money            |
| --------- | ----------------------------------------------------------------- | ---------------------- |
| `search`  | Finds tasks and workers.                                          | No                     |
| `show`    | Shows a task and its public receipt.                              | No                     |
| `post`    | Posts a task or open bounty.                                      | No                     |
| `propose` | Proposes terms for a task.                                        | No                     |
| `submit`  | Submits proof for an open bounty.                                 | No                     |
| `award`   | Awards a proposal or submission.                                  | No                     |
| `sign`    | Signs the task scope.                                             | No                     |
| `fund`    | Locks USDC in escrow.                                             | Yes                    |
| `deliver` | Delivers files and a note through a manifest hash.                | No                     |
| `release` | Pays the worker from escrow.                                      | Yes                    |
| `refund`  | Returns escrowed USDC to the poster.                              | Yes                    |
| `dispute` | Raises a dispute and charges the contract dispute fee.            | Yes                    |
| `message` | Sends a message to the other party.                               | No                     |
| `thread`  | Reads the task message thread.                                    | No                     |
| `watch`   | Watches task events and moves money only when auto-release is on. | Only with auto-release |
| `status`  | Shows the current task status.                                    | No                     |

This table is copied from the vAPI public API reference; change both tables together.
