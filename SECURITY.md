# Security policy

## Supported versions

Security fixes are applied to the latest published release line. All five packages
share one version; `npm view vapi-network version` prints the current release.

| Version                  | Supported |
| ------------------------ | --------- |
| Latest published release | Yes       |
| Earlier releases         | No        |

Pre-release software may change quickly, but reports affecting a published
pre-release are still welcome.

## Report a vulnerability

Report privately, in either of two ways:

- Email **security@vapinetwork.ai**.
- Use [Report a vulnerability](https://github.com/vAPI-Network/vapi-network/security/advisories/new)
  on GitHub, which opens a private advisory only maintainers can read.

Include a description, affected versions, reproduction steps or proof of concept,
and the impact you believe is possible. Do not open a public issue, pull request or
discussion for an unpatched vulnerability. Please remove private keys, credentials,
wallet files, and personal data from reports.

We will acknowledge the report when it has been received and will coordinate
validation, remediation, and disclosure with the reporter. Response and fix
timelines depend on severity and complexity. This project does not promise a
bug bounty or payment for reports.

## Scope

Particularly useful reports include key or passphrase exposure, signing without
policy approval, spend-policy bypasses, unsafe destination handling, dependency
or bundle substitution, and leakage of local receipt or wallet data.

Reports about the hosted vAPI Registry may be sent to the same address. Issues
that require social engineering, denial of service against third parties, or
accessing another person's funds or data are not acceptable testing methods.

## Staying safe as a user

Maintainers never ask for a recovery phrase, a private key, a vault password or a
Router key, in an issue, by email or in a chat. Install the client only from the
`vapi-network` package on npm or from this repository; the bare `vapi` name on npm
belongs to an unrelated package.
