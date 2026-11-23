---
title: "Staking contracts"
description: "Base mainnet staking, reviewer gate, token addresses, and fixed contract parameters."
order: 7
---

## Base mainnet addresses

| Contract or role         | Address                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `VapiStaking`            | [0x845971FC0CE42A4840B05D89271595D6645928C3](https://basescan.org/address/0x845971FC0CE42A4840B05D89271595D6645928C3) |
| `ThresholdReviewersGate` | [0xe08807a47B46d453C690B2eE653ed27556CFca28](https://basescan.org/address/0xe08807a47B46d453C690B2eE653ed27556CFca28) |
| Gate owner Safe          | [0x5b818A1B3D88402606d9a7B1A91FEAFFE1465947](https://basescan.org/address/0x5b818A1B3D88402606d9a7B1A91FEAFFE1465947) |
| vAPI token               | [0x1eA8deB921AA6015f4938010C848140b98108Dd2](https://basescan.org/address/0x1eA8deB921AA6015f4938010C848140b98108Dd2) |

`VapiStaking` was deployed at Base block **52859938**.

### Retired deployment

The first staking deployment, `VapiStaking` [0x8755c1d3740b9faED813e90C6a1D8B0df04fC9dC](https://basescan.org/address/0x8755c1d3740b9faED813e90C6a1D8B0df04fC9dC) with gate [0x25B61d914E13f057a53F15d13C2FD954101DEea5](https://basescan.org/address/0x25B61d914E13f057a53F15d13C2FD954101DEea5), had a seven-day cooldown. It was replaced on 2026-10-20 before anyone staked and holds no stake. Do not send vAPI to it; use the addresses above.

## Roles

`VapiStaking` holds active and pending vAPI, records timestamp checkpoints, and handles withdrawal requests, cancellations, and withdrawals. It is ownerless and not upgradeable.

`ThresholdReviewersGate` reads active stake for reviewer eligibility. The Safe controls threshold changes through the gate's timelock; it does not control staking principal.

The offchain Compute control plane reads historical stake and sets daily Router limits. It does not move staked tokens.

## Parameters

| Parameter                               | Value                       |
| --------------------------------------- | --------------------------- |
| Minimum nonzero active stake            | 1 vAPI                      |
| Withdrawal cooldown                     | 86,400 seconds, or 24 hours |
| Pending withdrawals per wallet          | 1                           |
| Current reviewer threshold              | 10,000 vAPI                 |
| Threshold bounds                        | 10,000–1,000,000 vAPI       |
| Threshold change notice                 | 7 days                      |
| Threshold execution window after notice | 14 days                     |
| Compute stake timestamp                 | 00:00:00 UTC each day       |
| Compute snapshot job                    | 00:10 UTC                   |

Pool size, runway, allocation cap, and allocation floor are service configuration rather than staking-contract constants. See [Compute entitlement](/stake/compute-entitlement/).

[Stake and unstake](/stake/stake-and-unstake/) covers the console flow. [Reviewer eligibility](/stake/reviewer-eligibility/) explains the gate; Tasks is still coming soon.
