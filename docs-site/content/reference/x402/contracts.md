---
title: "x402 contracts"
description: "Base mainnet contracts for legacy Call fee splits, FeeRouter distributions, and vAPI token burns."
order: 16
---

Use this page to find the Base mainnet contracts used by the x402 fee path and the vAPI token burn path. Each address links to BaseScan for onchain inspection.

## Base mainnet

| Contract           | Address                                                                                                               | What it does                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| FeeRouter          | [0xe11aeeC31E54E8E6E66382c8BdBFfd1000E0194B](https://basescan.org/address/0xe11aeeC31E54E8E6E66382c8BdBFfd1000E0194B) | Immutable, permissionless USDC distribution across the configured burn sink, operations address, and protocol treasury.                   |
| FeeSplitterFactory | [0x8405f917f6EfBd1447aF01Fe879529bcD313279D](https://basescan.org/address/0x8405f917f6EfBd1447aF01Fe879529bcD313279D) | Deterministically deploys one FeeSplitter per provider wallet. The factory fixes the token, treasury, and 95/5 split for its lifetime.    |
| BuybackBurner      | [0x910780Ac98BD2e7509CaF2f6833be947DD30d96b](https://basescan.org/address/0x910780Ac98BD2e7509CaF2f6833be947DD30d96b) | Executor-operated path that converts held USDC to vAPI and burns held vAPI. A separate permissionless function can retry a deferred burn. |
| vAPI token         | [0x1eA8deB921AA6015f4938010C848140b98108Dd2](https://basescan.org/address/0x1eA8deB921AA6015f4938010C848140b98108Dd2) | The vAPI token used by BuybackBurner as its burn target.                                                                                  |

Call takes no fee; new listings pay providers directly. Listings created before direct payout may still use the FeeSplitter until migrated. The legacy splitter sends 95% to the provider and 5% to the FeeRouter. The FeeRouter distributes its USDC according to its immutable configuration.

See [x402 on vAPI](/reference/x402/x402/) for the request and settlement flow.

Checked on 2026-10-30.
