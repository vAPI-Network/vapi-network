---
title: "Embedding the wallet and MCP server"
description: "Embed empty vaults, per-wallet link state, remote signing accounts and MCP streams through the published TypeScript packages."
order: 4
---

> [!NOTE]
> Call, Router, Stake and Agents are live. Tasks is coming soon.

Client 0.14.0 exposes these embedding interfaces through `@vapi-network/core` and `@vapi-network/mcp`. They are available since 0.12.0. Use them when your app manages the wallet lifecycle, signer process or MCP transport.

| Interface              | Public package       | Result                                      |
| ---------------------- | -------------------- | ------------------------------------------- |
| `createVault`          | `@vapi-network/core` | `Promise<void>`                             |
| `linkStates`           | `@vapi-network/core` | `Promise<Map<WalletName, WalletLinkState>>` |
| `remotePaymentAccount` | `@vapi-network/core` | `VapiPaymentAccount`                        |
| `createVapiServer`     | `@vapi-network/mcp`  | `VapiMcpServer` with a `connect` method     |

## Create a vault before its first account

The public `createVault` function creates an empty device vault. Create accounts later by name. An optional password protects the vault immediately and removes the device key from the supplied secret store.

The signature below comes from the published `vault-setup.d.ts`. The package index exports this function; the separate declaration in `vault.d.ts` is not the public entry point. Import `createVault` and `SecretStore` from `@vapi-network/core`.

```ts
export declare function createVault(
  home: string,
  options: {
    secrets: SecretStore;
    password?: string;
    now?: () => Date;
  },
): Promise<void>;
```

## Read each wallet's link state

Import `linkStates`, `WalletStore`, `SecretStore`, `WalletName` and `WalletLinkState` from `@vapi-network/core`. The function returns each wallet's state for one vAPI server. `WalletLinkState` is `"linked"`, `"not_linked"` or `"revoked"`.

The function checks local metadata and stored tokens before asking for active agents. A refused candidate token marks that candidate revoked. If the server cannot be reached, candidates stay linked; an outage does not establish revocation.

The published declaration is:

```ts
export declare function linkStates(args: {
  store: WalletStore;
  secrets: SecretStore;
  apiBase: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<Map<WalletName, WalletLinkState>>;
```

## Delegate signing to another process

Import `remotePaymentAccount`, `RemoteAccountArgs`, `RemoteSignRequest` and `RemoteAccountError` from `@vapi-network/core`. The account signs through a channel the caller supplies as `request`. The process that holds the key decides whether to answer each request.

| Argument    | Published type                                 | Purpose                                            |
| ----------- | ---------------------------------------------- | -------------------------------------------------- |
| `wallet`    | `string`                                       | Identifies the wallet.                             |
| `address`   | `Hex`                                          | Supplies the account address.                      |
| `publicKey` | `Hex`                                          | Supplies the public key.                           |
| `request`   | `(message: RemoteSignRequest) => Promise<Hex>` | Sends a signing request and returns its signature. |

`Hex` is the type imported from `viem` in the published declaration. `RemoteSignRequest` has either `kind: "typedData"`, `wallet` and `typedData: unknown`, or `kind: "message"`, `wallet` and `message: string`. `RemoteAccountError` extends `Error` and carries code `"not_permitted"`.

The published function declaration is:

```ts
export declare function remotePaymentAccount(args: RemoteAccountArgs): VapiPaymentAccount;
```

## Connect MCP to streams you supply

Import `createVapiServer` and `VapiServerOptions` from `@vapi-network/mcp`. The factory accepts optional `VapiServerOptions` and returns a `VapiMcpServer`. Call that instance's `connect` method with your input stream and output writer.

The method reads JSON-RPC lines from `input` and writes answers to `output`. Its return type is `void`. The package index exposes the factory rather than a named `VapiMcpServer` constructor export.

The method declaration in the published `server.d.ts` is:

```ts
connect(input: NodeJS.ReadableStream, output: {
    write(chunk: string): unknown;
}): void;
```

`VapiServerOptions` accepts an optional `account: VapiPaymentAccount`, `store: WalletStore`, `wallet: string` and `secretStore: SecretStore`. These let the host supply the signing account, local account store, initial wallet and secret store. The server also provides `connectStdio(): void` and `close(): Promise<void>`.

The local server registers these 56 canonical tools. Inputs are MCP arguments, rather than CLI flags.

| Tool                      | Inputs                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `docs.search`             | `query`                                                                                                                           |
| `docs.read`               | `url`                                                                                                                             |
| `vapi.status`             | None                                                                                                                              |
| `vapi.accounts`           | None                                                                                                                              |
| `vapi.siblings`           | `account`                                                                                                                         |
| `accounts.add`            | `name`, `caps`, `routerAllowanceUsd`, `link`                                                                                      |
| `accounts.caps`           | `name`, `perCallUsd`, `perDayUsd`, `ceilingUsd`                                                                                   |
| `accounts.send`           | `from`, `to`, `amountUsd`, `network`                                                                                              |
| `auth.link`               | `label`, `account`                                                                                                                |
| `auth.status`             | `wallet`                                                                                                                          |
| `router.models`           | None                                                                                                                              |
| `router.usage`            | `wallet`                                                                                                                          |
| `router.chat`             | `model`, `messages[]`, `max_tokens`, `wallet`                                                                                     |
| `router.buy`              | `usd` (`1`, `5`, `20`, `50`), `wallet`                                                                                            |
| `call.search`             | `query`, `kinds[]`, `network`, `limit`, `cursor`, `includeUnverified`, `includeOutage`                                            |
| `call.inspect`            | `id`, `endpoint`                                                                                                                  |
| `call.pay`                | `wallet`, `id` or `url`, `method`, `endpoint`, `body`, `contentType`, `network`, `expectedPayTo`, `maxPriceUsd`, `timeoutSeconds` |
| `call.read`               | `url`                                                                                                                             |
| `tasks.search`            | `open`, `minUsd`, `tab`, `limit`                                                                                                  |
| `tasks.show`              | `id`, `wallet`                                                                                                                    |
| `tasks.post`              | `wallet`, `title`, `brief`, `amountUsd`, `deadline`, `intake`, `maxAwards`, `webhookUrl`, `vendor`                                |
| `tasks.propose`           | `id`, `wallet`, `priceUsd`, `duration`, `note`                                                                                    |
| `tasks.submit`            | `id`, `wallet`, `proofUrls[]`, `files[]`                                                                                          |
| `tasks.award`             | `id`, `wallet`, `proposalId`                                                                                                      |
| `tasks.sign`              | `id`, `wallet`, `counterparty`, `wait`                                                                                            |
| `tasks.fund`              | `id`, `wallet`, `counterparty`, `wait`                                                                                            |
| `tasks.deliver`           | `id`, `wallet`, `files[]`, `note`, `counterparty`, `wait`                                                                         |
| `tasks.release`           | `id`, `wallet`, `counterparty`, `wait`                                                                                            |
| `tasks.refund`            | `id`, `wallet`, `counterparty`                                                                                                    |
| `tasks.dispute`           | `id`, `wallet`, `evidenceHash`, `counterparty`                                                                                    |
| `tasks.counter-evidence`  | `id`, `wallet`, `evidenceHash`, `counterparty`                                                                                    |
| `tasks.resolve-unmatched` | `id`, `wallet`, `counterparty`                                                                                                    |
| `tasks.message`           | `id`, `wallet`, `text`                                                                                                            |
| `tasks.thread`            | `id`, `wallet`, `after`                                                                                                           |
| `tasks.watch`             | `id`, `wallet`, `after`, `until`, `waitSeconds`                                                                                   |
| `tasks.status`            | `id`, `wallet`                                                                                                                    |
| `wallet.address`          | `wallet`                                                                                                                          |
| `wallet.balance`          | `wallet`                                                                                                                          |
| `wallet.accounts`         | `wallet`                                                                                                                          |
| `wallet.list`             | None                                                                                                                              |
| `wallet.use`              | `name`                                                                                                                            |
| `wallet.fund`             | `wallet`, `amountUsd`                                                                                                             |
| `receipts.list`           | `wallet`, `allWallets`, `limit`                                                                                                   |
| `receipts.stats`          | `wallet`, `allWallets`, `range`                                                                                                   |
| `support.report`          | `message`, `includeAddresses`, `send`                                                                                             |
| `swarm.setup`             | `name`, `agents`, `roles`, `strategy`, `targetsUsd`, `caps`, `treasuryCaps`, `network`, `model`, `fundUsd`, `from`                |
| `swarm.add`               | `name`, `role`, `targetUsd`, `weight`                                                                                             |
| `swarm.leave`             | `name`, `member`                                                                                                                  |
| `swarm.fund`              | `name`, `amountUsd`, `from`                                                                                                       |
| `swarm.rebalance`         | `name`, `targetsUsd`                                                                                                              |
| `swarm.status`            | `name`                                                                                                                            |
| `swarm.dissolve`          | `name`                                                                                                                            |
| `swarm.run`               | `name`, `task`, `mode`, `lead`, `budgetUsd`, `drawUsd`, `detach`                                                                  |
| `swarm.allocate`          | `amountUsd`, `reason`, `requestId`                                                                                                |
| `swarm.delegate`          | `member`, `task`, `budgetUsd`, `requestId`                                                                                        |
| `swarm.runs`              | `name`                                                                                                                            |

Task wait defaults to true. Watch defaults to after=0 and waitSeconds=25, bounded to 0–25 seconds.
Watch never releases escrow. The call.read, swarm.allocate and swarm.delegate tools reject direct MCP invocation.
The auth.link tool requests mcp:call, router.use, tasks:read and tasks:write.

Checked on 2026-11-17.
