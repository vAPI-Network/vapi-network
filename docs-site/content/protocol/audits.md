---
title: "Audits"
description: "Hacken's token and Uniswap V4 fee hook audit, and the unaudited Call fee contracts."
order: 115
---

This page is for readers checking contract audit coverage.

Hacken completed a manual security audit covering only the vAPI token (`VapiToken`) and its Uniswap V4 fee hook (`VapiFeeHook`). [Read the Hacken audit report](https://hacken.io/audits/vapi-network/sca-vapi-network-sc-audit-jul2026/).

The Call fee contracts (`FeeRouter`, `FeeSplitterFactory`, `BuybackBurner`) launched without an external audit. They have verified sources on Basescan. [Inspect the FeeRouter source](https://basescan.org/address/0xe11aeeC31E54E8E6E66382c8BdBFfd1000E0194B#code) and [inspect the FeeSplitterFactory source](https://basescan.org/address/0x8405f917f6EfBd1447aF01Fe879529bcD313279D#code).

This report does not cover staking or Tasks contracts.

Hacken Advisory advises vAPI on compliance, regulation, and security. SolidProof supports contracts and advisory work.

An audit lowers risk but does not remove it. Read the [risk statement and disclaimer](/legal/risk-statement-and-disclaimer/) before you use the contracts.

## Next

- [Risk statement and disclaimer](/legal/risk-statement-and-disclaimer/)
- [x402 contracts](/reference/x402/contracts/)
- [Roadmap and status](/products/roadmap-status/)
