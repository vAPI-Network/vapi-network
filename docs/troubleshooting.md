# Troubleshooting

The failures people report most often, with the cause and the fix. Check your version first: `vapi --version` prints the installed client and `npm view vapi-network version` prints the latest release.

## Linking an agent with `vapi login`

`vapi login` prints a link code, waits for the owner to approve it in the browser, then stores the link on this machine. Keep the terminal open until it reports the link; approving after the command has exited links nothing.

| Message                                                   | Cause                                                                                                          | Fix                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `The agent link could not be stored consistently.`        | Releases up to 0.14.0 fail on Linux keyrings where `secret-tool clear` exits 1 for an entry that is not there. | Update to a release after 0.14.0 and run `vapi login` again.              |
| `The vAPI agent link request failed (HTTP 429, ...)`      | Too many link requests from this wallet or network in a short time.                                            | Wait a few minutes, then run `vapi login` once.                           |
| `The vAPI agent link request failed (HTTP <status>, ...)` | The request was refused or never reached vAPI. The status and the error code say which.                        | Include the full message in a bug report.                                 |
| `The vAPI agent link request failed.`                     | Releases up to 0.14.0 print this for every refusal. A release after 0.14.0 adds the status and the error code. | Update, run `vapi login` again and read the new message.                  |
| `The agent link request expired.`                         | The link code was not approved before it expired, or the command could not reach vAPI while it waited.         | Run `vapi login` again and approve the new code straight away.            |
| `The agent wallet signature was rejected.`                | vAPI did not accept the sign-in message the agent account signed.                                              | Run `vapi login` again. If it repeats, report it with the client version. |
| `The owner denied the agent link.`                        | The owner pressed deny on the link page.                                                                       | Run `vapi login` again and approve.                                       |

Some agent sandboxes send traffic through an egress proxy that refuses OAuth token requests. The message then carries an error code vAPI does not issue, such as `refresh_rejected`, often with HTTP 502. vAPI cannot change that proxy. Run `vapi login` on your own computer, or in a sandbox that allows requests to `api.vapinetwork.ai`.

## Vault and secret store

| Message or symptom                                             | Cause                                                                                                      | Fix                                                                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Unable to decrypt the vault with this device key.` on Windows | Release 0.11.0 never saved the device key to Windows Data Protection. A vault it created cannot be opened. | Update to 0.12.0 or later, move `%USERPROFILE%\.vapi` aside and run `vapi setup` again. Choose `restore` if the account was funded. |
| `vapi setup` cannot store the device key on Linux              | The machine has no keyring: a server, a container or GitHub Codespaces.                                    | Set `VAPI_VAULT_PASSWORD` first. See [Linux without a keyring](./wallets.md#linux-without-a-keyring).                               |
| A password-protected vault fails in an MCP client or a script  | The process has no terminal to ask for the password.                                                       | Set `VAPI_VAULT_PASSWORD` for that process. See [wallets.md](./wallets.md).                                                         |

## Commands and payments

`npx vapi` runs an unrelated npm package. Use `npx vapi-network <command>`, or install the client with `npm i -g vapi-network` and run `vapi`.

Inspecting or paying a Solana listing returns `unsupported_network`. Solana listings stay searchable; vault payments on Solana arrive in a later release.

If you sent ETH to an agent account by mistake, the account still holds it on Base. Send it back minus the Base network fee:

```sh
vapi sweep <your-address> --asset eth
```

## Report a bug

`vapi report "<what happened>"` writes a report file and prints a prefilled GitHub issue link. The report holds the message, the client version, OS and Node information and the newest five receipt ids. Addresses are included only with `--include-addresses`, and nothing is uploaded unless you add `--send`.

Never paste a recovery phrase, a private key, a vault password or a Router key into an issue. Questions about an account, points or a quest are answered on [Discord](https://discord.gg/vapinetwork) and [Telegram](https://t.me/vapinetwork), because maintainers cannot look up an account from a public issue.

## Router purchases awaiting recovery

Keep the receipt id and transaction when Router reports an unconfirmed authorization or credit awaiting confirmation.
Retry chat without repeating the purchase; a settled journal keeps guarding against another payment until credit and receipt persistence are established.
After relinking, recovery accepts the same owner (case-insensitive) and API base. Usage reaching the recorded baseline plus the purchased tier or a successful balance-key chat proves usable credit; entries without a baseline still require chat.
The payment journal stays pending under a missing link or another owner or API base. Stake-key chat continues under a valid current link with usable credentials. With no link, chat returns `not_linked` and the error still carries `pending_purchase_unlinked`.
See [Router recovery](router.md#purchase-recovery) for inspection and explicit settled retirement; keep the printed evidence and contact support if credit does not appear.
