---
title: "Safety phrase"
description: "The Tasks beta derives a four-word safety phrase from the onchain terms hash so parties can compare a signed scope."
order: 5
---

> [!NOTE]
> Tasks v2 is in public beta on Base Sepolia with test USDC. This page describes the safety phrase as it works today.

The safety phrase is a short way for the poster and worker to compare the same signed scope. Compare it out of band before relying on the terms of a task.

## What it is

Each task escrow has one public onchain `termsHash`, covering every milestone inside it. Tasks derives four lowercase words from that hash. The phrase is a comparison aid, not a replacement for checking the full hash or signatures.

The phrase is not stored as a separate escrow field. Anyone can reproduce it from the public `termsHash` shown on BaseScan.

## How it is derived

At a conceptual level, the derivation:

1. Checks that `termsHash` is `0x` followed by exactly 64 hexadecimal characters.
2. Reads bytes 0, 8, 16, and 24 from the hash.
3. Uses those four byte values as indexes into the fixed 256-word table.
4. Joins the four lowercase words with one space.

For example, the hash below produces `amber bamboo cabin coral`:

```text
0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
```

## Compare it safely

Both parties should view the phrase beside the authoritative escrow state and say the words to each other out of band. If the phrases do not match, stop and compare the full `termsHash` and signatures. A mismatch means that you are not looking at the same signed scope.

A matching phrase is a quick check only. Different terms hashes can share the same four-word phrase, so use the full hash for exact verification.

Checked on 2026-11-17.
