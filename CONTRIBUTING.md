# Contributing

Thanks for helping make x402 access more open and composable. This guide covers what
we accept, how to set up the workspace, the checks a change must pass and how review
works.

## What we accept

| Contribution                                   | How to start                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| A bug fix with a regression test               | Open a pull request. Link the issue if there is one.                            |
| Documentation fixes and clearer error messages | Open a pull request.                                                            |
| A new discovery source or signer               | Open a "New discovery source or signer" issue first.                            |
| A feature or a change to a public interface    | Open an issue first, so the design is agreed before you write the code.         |
| A question or an early idea                    | Start a [discussion](https://github.com/vAPI-Network/vapi-network/discussions). |

Issues labelled `good first issue` are small and self-contained, and `help wanted`
marks work a maintainer will not get to soon.

Some things are out of scope, and saying so early saves your time:

- Custody, a payment proxy, a server-side signer or telemetry that leaves the machine
  by default. The invariants are listed in [AGENTS.md](./AGENTS.md).
- Provider-specific adapters, examples or integrations. `@vapi-network/sources`
  adapts catalogs, not single providers. To have an API found by every vAPI client,
  list it with `vapi publish`; see [docs/call.md](./docs/call.md#publish-an-api).
- A runtime dependency in a published package. Every tarball is bundled and ships
  with zero runtime dependencies.

Support questions about an account, points or a quest do not belong in an issue;
[SUPPORT.md](./SUPPORT.md) lists where they are answered. Vulnerabilities go through
the private process in [SECURITY.md](./SECURITY.md), never a public issue.
Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Set up the workspace

Install Node.js 22 and pnpm 10, then run:

```sh
pnpm install --frozen-lockfile
pnpm build
```

The repository is a pnpm workspace. Packages live under `packages/`, the macOS app
lives under `apps/desktop`, and the runnable SDK examples live under `examples/`.
The examples are type-checked by `pnpm typecheck`, so they cannot drift from the API
they demonstrate.

## Make a change

Keep changes focused and preserve these boundaries:

- `core` owns protocol, wallet, policy, discovery contracts, and local receipt
  behavior without depending on a CLI or transport.
- `sources` adapts catalogs to core's `Source` interface.
- `mcp` and `cli` are thin interfaces over core and sources.
- `vapi-network` is the zero-dependency, batteries-included npm distribution.

Add or adapt tests for behavior changes. Network tests use injected `fetch`
implementations or fixtures; the test suite never depends on a live service, a
funded wallet or a real keyring. Never include private keys, wallet files,
credentials, or production request data in an issue, fixture, recording, or commit.

When a change is visible to users, add a line under `Unreleased` in
[CHANGELOG.md](./CHANGELOG.md) and update the guide it affects. Guides follow
[docs/STYLE.md](./docs/STYLE.md), which `pnpm lint:copy` checks. Every MCP tool is
named in [docs/mcp.md](./docs/mcp.md) and every CLI command in
[docs/cli.md](./docs/cli.md).

Before opening a pull request, run:

```sh
pnpm check
pnpm build
pnpm pack:check
```

`pnpm check` runs the formatter check, the linter, the type checker, the tests and
the copy lint. `pnpm pack:check` builds all publishable packages, creates a
`publish/` directory beside each package manifest, and inspects every npm tarball.
Package `files` entries must be literal top-level paths rather than globs so the
staging step is deterministic.

## Commits and sign-off

Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org):
a type, an optional package scope and a short summary, for example
`fix(core): treat a missing keyring entry as absent`. The types in use are `feat`,
`fix`, `docs`, `test`, `refactor`, `perf` and `chore`.

Every commit carries a `Signed-off-by` line. It certifies the
[Developer Certificate of Origin](https://developercertificate.org): you wrote the
change or have the right to submit it under the project's license. Git adds the line
for you:

```sh
git commit -s -m "fix(core): treat a missing keyring entry as absent"
```

The `dco` check fails a pull request with an unsigned commit. To sign commits you
already made, amend the last one or rebase the branch, then push again:

```sh
git commit --amend -s --no-edit        # the last commit
git rebase --signoff main              # every commit on the branch
git push --force-with-lease
```

## AI-assisted contributions

Changes written with an AI assistant are welcome on the same terms as any other. You
are the author: read and understand every line, run the checks above yourself, and
say in the pull request that an assistant was used. A pull request whose author
cannot explain it, or that reports tests it did not run, is closed.

## Pull requests and review

Describe the user-visible behavior, the tests you ran, and any compatibility or
security consequences. Keep refactors separate from behavior changes when
practical. Do not edit generated `dist/`, `publish/`, coverage, or tarball files;
they are ignored and rebuilt by CI.

CI on a first pull request waits for a maintainer to approve the run. Maintainers
aim to give a first response within five working days. A pull request needs one
approving review from a code owner and green `verify` and `dco` checks; maintainers
squash or rebase it onto `main`, which keeps a linear history. Changes that touch
keys, signing, spend policy or the network guard get a second, security-focused
read and take longer.

Maintainers publish releases to npm by hand; [docs/releasing.md](./docs/releasing.md)
describes the steps. A merged fix reaches users with the next release, and the
changelog names the version.

By contributing, you agree that your contributions are licensed under the
repository's Apache-2.0 license.
