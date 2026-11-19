# Releasing

Maintainers release all five packages together, under one version. Publishing to npm is done by hand from a maintainer's machine; no workflow holds npm credentials.

## Version and changelog

Every `package.json` carries the same version. These files pin it as well and move in the same commit:

| File                                  | What to change                                |
| ------------------------------------- | --------------------------------------------- |
| `scripts/pack-check.mjs`              | `EXPECTED_VERSION`                            |
| `packages/cli/src/version.ts`         | `CLI_VERSION`                                 |
| `packages/core/src/support-report.ts` | `VAPI_CLIENT_VERSION`                         |
| `server.json`                         | Both `version` fields                         |
| `packages/vapi-network/SKILL.md`      | `version` in the frontmatter                  |
| `README.md`                           | The "describes client" line in the quickstart |
| `packages/core/README.md`             | The `VAPI_CLIENT_VERSION` row                 |

Rename the `Unreleased` heading in `CHANGELOG.md` to `## <version> — <date>` and add an empty `Unreleased` heading above it. Follow semantic versioning: before 1.0.0 a breaking change raises the minor version and is marked as breaking in the changelog.

Open the release as a pull request titled `chore: release <version>`. Merge it once `verify` and `dco` are green.

## Publish to npm

Run the "Prepare npm release" workflow on `main`. It builds the workspace, checks every tarball and prints the publish commands. Then, from a clean checkout of the same commit:

```sh
pnpm install --frozen-lockfile
pnpm pack:check
npm login
pnpm --dir packages/core publish:npm
pnpm --dir packages/sources publish:npm
pnpm --dir packages/mcp publish:npm
pnpm --dir packages/cli publish:npm
pnpm --dir packages/vapi-network publish:npm
```

npm reads a package manifest before lifecycle hooks run, so each command publishes the staged `publish/` directory, never the workspace package root. `publish:npm` goes to the `latest` npm tag and `publish:npm:next` puts the same tarball on `next`.

Check the result from an empty directory:

```sh
npx -y vapi-network@latest version
```

## Tag the release

Tag the commit npm was published from and push the tag:

```sh
git tag -a v<version> -m "vapi-network <version>"
git push origin v<version>
```

The "GitHub release" workflow checks the tag against the package version and publishes a GitHub release with that version's changelog section as its notes. A tag with a hyphen, such as `v0.15.0-rc.1`, is published as a pre-release. vAPI Desktop has its own tags, `desktop-v<version>`, described in [the desktop release guide](../apps/desktop/RELEASE.md).

## After the release

Close the issues the release fixes with the version that carries the fix. Update `SKILL.md` on vapinetwork.ai when the packaged copy changed.
