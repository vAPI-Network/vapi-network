---
title: "Router deposit contracts"
description: "Base mainnet deployment addresses and USDC forwarding for Router deposits."
order: 14
---

Router deposit addresses forward canonical Base USDC to the production treasury.
Each profile gets one permanent deterministic address, predicted from a profile-derived salt, factory and implementation.
The address is a forwarder rather than a wallet the user controls.

## Base mainnet

These addresses come from the app deployment record contracts/deployments/router-deposit-base-production.json.
The deployment start block is 58669300 on Base, chain ID 8453.
Use BaseScan to inspect the deployed contracts.

| Contract                 | Address                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Factory                  | [0x0Fa4EEB883D18f0FE71eBC411137c674Cf1E5D9e](https://basescan.org/address/0x0Fa4EEB883D18f0FE71eBC411137c674Cf1E5D9e) |
| Forwarder implementation | [0xEB319E8F7f0dA1CDC2bD480dd3B9f5582c6B1548](https://basescan.org/address/0xEB319E8F7f0dA1CDC2bD480dd3B9f5582c6B1548) |
| Treasury                 | [0x6B7B3cb62a2D7d232Bf5e0D030676bfb4F9Ba4E5](https://basescan.org/address/0x6B7B3cb62a2D7d232Bf5e0D030676bfb4F9Ba4E5) |

Anyone can deploy or flush a forwarder.
Its USDC can only move to its immutable treasury.
Router crediting does not wait for the treasury sweep.
See [Agents and Router](/reference/http-api/agents-and-router/#router-deposits) for address issuance, deposit reads and owner-confirmed claims.
See [Buy Router balance](/router/buy-router-balance/) for funding steps and confirmation rules.

Checked on 2026-11-17.
