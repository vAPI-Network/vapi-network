---
title: "Troubleshooting"
description: "Fix Linux keyring setup errors, configure headless vault storage, and recover older Windows vaults."
order: 6
---

This page is for owners who cannot finish local vault setup on Linux, in a container or on Windows.

| Symptom                                                   | Cause                                        | Fix                                                                                   |
| --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Linux setup cannot store the device key                   | Missing or locked libsecret keyring          | Install or open the desktop keyring, or set `VAPI_VAULT_PASSWORD` before setup        |
| Container or Codespace setup has no working keyring       | No desktop secret service                    | Make `VAPI_VAULT_PASSWORD` available in the terminal before setup                     |
| Windows vault created before client 0.12.0 cannot decrypt | The older client did not save the device key | Move the old vault directory aside, then restore or create a vault with current setup |

## Linux keyring errors

Since client 0.12.1, failed device-key storage names the reason. Reasons include `secret-tool` not installed, no keyring daemon, a locked collection or no D-Bus session. The daemon error can name `org.freedesktop.secrets` as unavailable.

On a desktop, install or open the keyring and retry setup. On Linux without a working keyring, set `VAPI_VAULT_PASSWORD` to at least 12 characters before setup. Since client 0.13.0, the client keeps the device key and agent link in encrypted `~/.vapi/secrets.json`.

The choice is fixed once per vault in `~/.vapi/secret-store.json`. Every later command for that vault needs the variable set. Existing vaults, macOS, Windows and Linux with a working keyring keep the OS store. This choice is separate from password protection through the vault protect command; see [How wallets work](/agents/wallets/how-wallets-work/#servers-and-ci).

Current setup options can be inspected without creating a wallet:

```bash
npx -y vapi-network@0.14.0 --help
```

Excerpt from the captured help:

```text
  vapi setup [--no-cloud-backup] [--accounts <n>] [--json]
```

## Containers and GitHub Codespaces

A container without a working keyring uses the same Linux setup path. In GitHub Codespaces, add `VAPI_VAULT_PASSWORD` as a Codespaces secret with at least 12 characters. The secret must be visible as an environment variable in the Codespace terminal before setup runs. Keep it available for later commands that use the vault.

## Older Windows vaults

A Windows vault created before client 0.12.0 can fail with “Unable to decrypt the vault with this device key.” The older client did not save the device key, so that vault cannot be opened. Move `%USERPROFILE%\.vapi` aside and run setup again:

```powershell
vapi setup
```

Choose `restore` if the account was funded. Restore requires the recovery phrase. For an unfunded account, you can create a new vault.

Client 0.14.0 preserves the existing secret-store selection during repeated setup. An unpinned existing vault stays OS-backed.
Setup locks backend selection against concurrent runs and validates existing encrypted credentials instead of replacing entries.
A locked encrypted-file store remains encrypted and never falls back to plaintext. Set VAPI_VAULT_PASSWORD to open it.

## Next

- [How wallets work](/agents/wallets/how-wallets-work/)
- [Backup and recovery](/agents/wallets/backup-and-recovery/)
- [CLI reference](/reference/cli/cli-reference/)

Checked on 2026-11-17.
