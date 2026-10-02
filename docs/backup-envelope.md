# Backup envelope format

The first rule is non-custodial. Backup keys and plaintext stay on the owner's device. A relay or storage service receives only opaque encrypted bytes. Backup functions never log secrets or write them to the audit log, and errors never contain them.

This page specifies plaintext versions 1 and 2 inside the version 1 envelope. It does not define a server API or a retention policy.

## Backup envelope

The envelope is UTF-8 JSON with these fields in this order. Serializers must emit no extra fields.

| Field        | Value                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------- |
| `format`     | The string `vapi-vault-backup`                                                              |
| `v`          | The number `1`                                                                              |
| `owner`      | A lowercase 20-byte EVM address with a `0x` prefix                                          |
| `device`     | A lowercase device name matching `[a-z0-9][a-z0-9-]{0,31}`                                  |
| `createdAt`  | An ISO 8601 UTC timestamp with exactly three fractional digits                              |
| `kdf`        | The key derivation object described below                                                   |
| `cipher`     | `{"name":"aes-256-gcm","nonce":"<12-byte base64url>"}`                                      |
| `ciphertext` | AES-256-GCM ciphertext followed by its 16-byte tag, encoded as unpadded canonical base64url |

The `hkdf-sha256` key derivation object has this field order:

```json
{ "name": "hkdf-sha256", "salt": "<32-byte base64url>" }
```

The `scrypt` key derivation object has this field order:

```json
{ "name": "scrypt", "salt": "<32-byte base64url>", "N": 131072, "r": 8, "p": 1 }
```

AES-256-GCM authenticates this exact UTF-8 AAD string:

```text
vapi-vault-backup|1|<owner>|<device>|<createdAt>|<kdf name>|<salt>|<N or empty>|<r or empty>|<p or empty>|<nonce>
```

The three scrypt parameter positions are empty for `hkdf-sha256`. The serialized envelope may contain at most 65,536 UTF-8 bytes. Readers reject a larger value before JSON parsing.

## Plaintext version 1

The decrypted UTF-8 JSON contains these fields in this order:

| Field              | Value                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `v`                | The number `1`                                                                                |
| `phrase`           | The device vault recovery phrase                                                              |
| `nextDerivedIndex` | The next unused derivation index                                                              |
| `accounts`         | Derived account metadata and imported accounts, including each imported private key           |
| `registry`         | The default account, ordered account labels and spend caps, and sorted unique CAIP-2 networks |
| `protected`        | Whether the source vault had password protection                                              |

The plaintext excludes the device encryption key, vault password, owner key, bearer and refresh tokens, Router keys, registry API key and OS secret-store contents. It also excludes audit, receipt, search and spend-ledger files.

## Plaintext version 2

Version 2 adds account ceilings, automatic Router refill settings, agent profiles, swarms and unfinished capital movements. Its fields appear in this exact order:

```text
{ v: 2, phrase, nextDerivedIndex, accounts, registry: { default?, accounts: [{ name, label?, spendCaps, ceilingAtomic?, routerRefill? }], networks }, protected, agents?, swarms?, movements?, transferReceipts? }
```

The first six fields keep their version 1 meanings. `ceilingAtomic` is absent for the default 5 USDC ceiling. A non-default value is present. `null` means that the ceiling is off. `routerRefill` is absent when automatic Router refill is not set.

The writer uses version 1 when there are no agents, swarms, unfinished movements or transfer receipts, every account uses the default ceiling, and no account has Router refill settings. It uses version 2 when any of that version 2-only data is present.

The optional arrays use this canonical order:

| Field       | Order                         |
| ----------- | ----------------------------- |
| `agents`    | Profile name                  |
| `swarms`    | Swarm name                    |
| `movements` | `createdAt`, then movement id |

`movements` contains only unfinished movement files. A movement is unfinished when at least one leg can still move money or resume. A `planned`, `unknown`, retryable `failed`, or journal-signed `failed` leg keeps it unfinished. A version 2 leg may also be `cancelled`; that state is terminal and survives restore unchanged. Local movement files bind sender and recipient names to addresses, but backup plaintext omits those fields.

`transferReceipts` contains only `kind: "transfer"` receipts whose wallet and nonce match a leg in an included movement. Each receipt is reduced to this allow-list, in this order:

```text
{
  id,
  timestamp,
  kind,
  wallet,
  resourceUrl,
  quote: { network, asset, amountAtomic },
  transfer: {
    to,
    toName,
    toKind,
    amountAtomic,
    network,
    nonce,
    status,
    txHash,
    replayed,
    reservedOn?,
    request?: {
      authorization: { from, to, value, validAfter, validBefore, nonce },
      signature
    }
  },
  error?: { code, message }
}
```

The quote keeps the network and token contract needed to check an authorization nonce on-chain. The signed transfer authorization is present only so an open leg can replay without another signature. It adds no signing power to plaintext that already contains the recovery phrase.

Transfer receipts are an append-only journal. When one transfer ID has a signed revision followed by a terminal revision, both rows are retained in their original order.

Backup export checks the account, movement, and receipt snapshots before it builds version 2 plaintext. Every included unknown leg must match a captured receipt by wallet and nonce. The same rule covers failed legs that the journal proved signed when it selected the movement. A changing snapshot gets three attempts, then stops before encryption or upload.

Version 2 excludes account links, bearer and refresh tokens, Router keys, registry API keys, device codes and pending ceiling-sweep state. It also excludes the device encryption key, vault password, owner key, OS secret-store contents, audit log, spend ledger, searches, finished movements and unrelated receipts.

### Size priority

The writer tries progressively smaller plaintexts. Both the encrypted envelope and the owner restore relay payload must fit 65,536 UTF-8 bytes.

| Priority | Plaintext contents                                             | Reported `omitted`              |
| -------- | -------------------------------------------------------------- | ------------------------------- |
| 1        | Full version 2                                                 | Absent                          |
| 2        | Version 2 without `agents`                                     | `agents`                        |
| 3        | Version 2 without `agents` or `swarms`                         | `agents`, `swarms`              |
| 4        | Version 2 without agents, swarms, movements, or their receipts | `agents`, `swarms`, `movements` |

Each dropped optional key is absent, rather than present with an empty array. Account ceilings and Router refill settings are never dropped. If the remaining data has the version 1 shape, the last candidate is version 1. This keeps a vault-only backup byte-identical to the version 1 path. If required version 2 policy does not fit after all optional sections are removed, the writer returns `backup_too_large`. The `omitted` list is returned beside the envelope and reaches the cloud-upload result.

Relay budgeting uses the backup KDF and owner, a 43-character base64url key, and a 32-character device name. This is the largest valid device name.

### Reader compatibility

Readers accept both plaintext versions. A source with the version 1 shape writes version 1 plaintext. A version 2 source also writes version 1 when it has no version 2-only data.

The outer envelope, its version, both KDF paths and the relay sealed-box format are unchanged. The relay restore payload stays at version 1 and may carry either plaintext version in `vault`.

## Owner key paths

The preferred path asks the owner wallet to sign this EIP-712 data:

```json
{
  "domain": { "name": "vAPI Vault Backup", "version": "1" },
  "types": {
    "VaultBackupKey": [
      { "name": "purpose", "type": "string" },
      { "name": "site", "type": "string" },
      { "name": "owner", "type": "address" },
      { "name": "version", "type": "uint256" }
    ]
  },
  "primaryType": "VaultBackupKey",
  "message": {
    "purpose": "Derive the key that encrypts and decrypts my vAPI agent vault backups. Only sign this on vapinetwork.ai.",
    "site": "vapinetwork.ai",
    "owner": "<checksummed owner address>",
    "version": 1
  }
}
```

The signature is 65 bytes. Normalization maps recovery values `0` and `1` to `27` and `28`. It converts high-s signatures to low-s form and flips the recovery value. Other recovery values, zero s and s values outside the secp256k1 order are unsupported.

HKDF-SHA256 takes the normalized signature as input key material and the envelope's 32-byte salt. Its UTF-8 info is:

```text
vapi-vault-backup/v1|<lowercase owner>|<device>
```

The output is the 32-byte AES key. The client signs the same typed data twice before choosing this path. Different normalized signatures or an unsupported signature select the password path.

The password path normalizes the password with Unicode NFKC and requires at least 12 Unicode code points. Scrypt derives 32 bytes with `N=131072`, `r=8`, `p=1`, the envelope's 32-byte salt and a 256 MiB memory ceiling.

## Relay sealed box

The relay recipient creates an X25519 key pair. The sender creates an ephemeral X25519 key pair and derives their shared secret. HKDF-SHA256 derives a 32-byte AES key with these inputs:

| Input | Value                                                                         |
| ----- | ----------------------------------------------------------------------------- |
| IKM   | The X25519 shared secret                                                      |
| Salt  | The 32-byte ephemeral public key followed by the 32-byte recipient public key |
| Info  | UTF-8 `vapi-vault-relay/v1`                                                   |

The sealed box is UTF-8 JSON with these fields in this order:

```json
{
  "format": "vapi-vault-relay",
  "v": 1,
  "epk": "<32-byte base64url>",
  "nonce": "<12-byte base64url>",
  "ciphertext": "<ciphertext+16-byte-tag base64url>"
}
```

AES-256-GCM authenticates this exact UTF-8 AAD string:

```text
vapi-vault-relay|1|<epk>|<nonce>
```

The sender rejects plaintext above 65,536 bytes. Both sides reject an all-zero X25519 shared secret.

The relay code is the first 60 bits of SHA-256 over the recipient's 32-byte public key. Encode those bits with the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, then group the uppercase result as `XXXX-XXXX-XXXX`.

## Relay payload

An `enroll` relay gives an existing vault its device-specific backup key and salt. A `restore` relay gives a new device the vault plaintext plus a fresh key and salt. The sender seals this UTF-8 JSON with `sealTo`, using the exact field order shown:

```json
{
  "format": "vapi-vault-relay-payload",
  "v": 1,
  "purpose": "enroll" | "restore",
  "owner": "<lowercase owner address>",
  "device": "<recipient device name, equal to the relay record's device>",
  "kdf": { "name": "hkdf-sha256", "salt": "<b64url 32 bytes>" }
       | { "name": "scrypt", "salt": "<b64url 32 bytes>", "N": 131072, "r": 8, "p": 1 },
  "key": "<b64url 32 bytes: the AES-256-GCM backup key for THIS device>",
  "vault": <restore only: the decrypted vault plaintext object exactly as inside the source envelope; absent for enroll>
}
```

The recipient applies every check before it stores a key or writes a vault.

| Check     | Requirement                                                                        |
| --------- | ---------------------------------------------------------------------------------- |
| Format    | `format` is `vapi-vault-relay-payload`.                                            |
| Version   | `v` is `1`.                                                                        |
| Fields    | The object and its `kdf` use the exact key sets above. Unknown fields are refused. |
| Owner     | `owner` is lowercase and equals the expected owner when the caller supplies one.   |
| Device    | `device` equals this device's name.                                                |
| Purpose   | `purpose` matches the relay request.                                               |
| Key       | `key` is canonical base64url that decodes to exactly 32 bytes.                     |
| KDF salt  | `kdf.salt` is canonical base64url that decodes to exactly 32 bytes.                |
| KDF shape | Scrypt uses `N=131072`, `r=8`, and `p=1`. HKDF has no additional fields.           |
| Vault     | `vault` is present only for `restore` and matches plaintext version 1 or 2.        |

The sealed plaintext may contain at most 65,536 UTF-8 bytes. The backup writer budgets this payload before it chooses optional sections. It uses a 32-character device name for the size check. The sender refuses a larger payload and never truncates it.

### Anti key-swap rule

The browser fetches the relay record and recomputes `relayCode(publicKey)`. It refuses unless the result equals the code the owner typed. A server that substitutes its own public key cannot receive a sealed payload because its public key produces another code.

## Errors

Callers receive `BackupError` with one of these stable codes and messages.

| Code                    | Message                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `backup_too_large`      | `Backup envelope exceeds 65,536 bytes.`                                                                     |
| `backup_open_failed`    | `Unable to open backup.`                                                                                    |
| `backup_unsupported`    | `Unsupported backup envelope.`                                                                              |
| `unsupported_signature` | `Unsupported signature.`                                                                                    |
| `weak_password`         | `Password must contain at least 12 characters.`                                                             |
| `backup_invalid_input`  | `Invalid backup input.`                                                                                     |
| `backup_snapshot_busy`  | `Backup files changed while they were being captured. Retry the backup; no backup was created or uploaded.` |
| `relay_open_failed`     | `Unable to open relay payload.`                                                                             |
| `relay_invalid_key`     | `Invalid relay key.`                                                                                        |
| `vault_exists`          | `A vault already exists.`                                                                                   |

Authentication failures do not reveal which authenticated field, key, ciphertext byte or plaintext rule failed.

## Test vectors

Deterministic interoperability vectors live in [`packages/core/src/backup-vectors.json`](../packages/core/src/backup-vectors.json). They cover owner-signature HKDF, password scrypt and X25519 relay sealing.
