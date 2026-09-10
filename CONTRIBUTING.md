# Contributing

Thanks for helping make x402 access more open and composable.

## Before you start

- Search existing issues before opening a new one.
- For a large feature or a change to a public interface, open an issue first so
  the design can be agreed before implementation.
- Never include private keys, wallet files, credentials, or production request
  data in an issue, fixture, recording, or commit.
- Vulnerabilities belong in the private process described in
  [SECURITY.md](./SECURITY.md), not a public issue.

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Set up the workspace

Install Node.js 22 and pnpm 10, then run:

```sh
pnpm install --frozen-lockfile
pnpm build
```

The repository is a pnpm workspace. Packages live under `packages/`, and the
direct SDK example lives under `examples/`.

## Make a change

Keep changes focused and preserve these boundaries:

- `core` owns protocol, wallet, policy, discovery contracts, and local receipt
  behavior without depending on a CLI or transport.
- `sources` adapts catalogs to core's `Source` interface.
- `mcp` and `cli` are thin interfaces over core and sources.
- `vapi-network` is the zero-dependency, batteries-included npm distribution.

Add or adapt tests for behavior changes. Network tests should use injected
`fetch` implementations or fixtures; the normal test suite must not depend on
live services.

Before opening a pull request, run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

`pnpm pack:check` builds all publishable packages, creates a `publish/`
directory beside each package manifest, and inspects every npm tarball. Package
`files` entries must be literal top-level paths rather than globs so the staging
step is deterministic.

## Pull requests

Describe the user-visible behavior, the tests you ran, and any compatibility or
security consequences. Keep refactors separate from behavior changes when
practical. Do not edit generated `dist/`, `publish/`, coverage, or tarball files;
they are ignored and rebuilt by CI.

By contributing, you agree that your contributions are licensed under the
repository's Apache-2.0 license.
