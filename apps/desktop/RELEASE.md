# vAPI Desktop releases

Desktop releases are built from `desktop-vX.Y.Z` tags in `vAPI-Network/vapi-network`.
The workflow uses GitHub-hosted `macos-15` runners and creates a draft release in this repository.
A maintainer reviews the assets and publishes the draft.

Any other GitHub Release in this repository must be marked pre-release.
`electron-updater` takes the newest full release as the desktop update.
Publishing an npm release as a full GitHub Release can break desktop updates.

## One-time setup

Export the Apple Developer ID Application certificate and its private key from Keychain Access as a password-protected `.p12`.
Base64-encode the file for `CSC_LINK` and use the export password as `CSC_KEY_PASSWORD`.
Do not commit either value.

```sh
base64 < DeveloperID.p12 | pbcopy
```

Create an Apple app-specific password for notarization.
Create a GitHub environment named `desktop-signing` in this repository.
Require reviewers and restrict deployments to tags matching `desktop-v*`.
Store these five values as environment secrets:

| Secret                        | Value                                          |
| ----------------------------- | ---------------------------------------------- |
| `CSC_LINK`                    | Base64-encoded Developer ID Application `.p12` |
| `CSC_KEY_PASSWORD`            | Certificate export password                    |
| `APPLE_ID`                    | Apple ID used for notarization                 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password                    |
| `APPLE_TEAM_ID`               | Apple developer team ID                        |

The release job has `contents: write` permission and uses the built-in GitHub token to create the draft.
No separate releases repository or personal access token is needed.
The environment approval gates access to the signing secrets.

## Build and test on macOS

Use Node.js 22, pnpm 10.27.0 and Xcode command-line tools.
Run these commands from the repository root.
The workspace build generates the Node shim; the native build compiles the Swift helpers for Apple Silicon and macOS 13.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir apps/desktop native:build
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop test
pnpm --dir apps/desktop check:copy
node --test apps/desktop/scripts/*.test.mjs
pnpm --dir apps/desktop pack:mac
pnpm --dir apps/desktop check:packaged
```

Without signing variables, packaging produces an ad-hoc signed development build and skips notarization.
For a release build, supply all five signing variables above.
The packaged check verifies the signature, Electron fuses, bundled helpers and minimum macOS version.

## Release

1. Bump `apps/desktop/package.json` to `X.Y.Z` and merge the reviewed change.
   Run the macOS checks above, including the packaged check.
   Confirm that `apps/desktop/update-control.json` permits the intended version.
2. Create and push the release tag from the reviewed commit:

   ```sh
   git tag desktop-vX.Y.Z
   git push origin desktop-vX.Y.Z
   ```

3. Approve the `desktop-signing` environment job.
   It checks tag/version parity, installs from the frozen lockfile, builds the workspace and native helpers, and tests the app.
   It then signs and notarizes the arm64 DMG and ZIP and checks the packaged app.
   Packaging does not publish automatically.
4. Review the draft in this repository.
   Expect the DMG, ZIP, blockmaps, `latest-mac.yml`, `build-info.json` and `SHA256SUMS`.
   Confirm the source commit and tag in `build-info.json`, successful signing, and `stagingPercentage: 10`.
   Add release notes and publish the desktop draft as a full release.
   The workflow matches installers by SHA-512 and renames them and their blockmaps to the filenames in the update metadata.
5. Fetch the tag and verify the published bytes:

   ```sh
   git fetch origin tag desktop-vX.Y.Z
   pnpm desktop:release-verify desktop-vX.Y.Z
   ```

The verifier uses the public GitHub API without credentials; drafts are unavailable to it.
It checks the local tag commit and version, every asset's SHA-256 except the checksum manifest, and installer hashes against `latest-mac.yml`.
On macOS, it also requires Gatekeeper acceptance and notarization for the DMG.
Other systems report that the Gatekeeper check was not performed.

## Staged rollout

The workflow sets `stagingPercentage: 10` in `latest-mac.yml`.
After reviewing release feedback, change it to `50`, then `100`.
Use an empty directory for these downloads and refresh the manifest checksum after editing the rollout percentage.

```sh
gh release download desktop-vX.Y.Z --repo vAPI-Network/vapi-network --pattern latest-mac.yml --pattern SHA256SUMS
# Edit only stagingPercentage in latest-mac.yml.
node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const hash = createHash('sha256').update(readFileSync('latest-mac.yml')).digest('hex');
const sums = readFileSync('SHA256SUMS', 'utf8');
if (!/^[a-f0-9]{64}  latest-mac\.yml$/m.test(sums)) throw new Error('Missing manifest checksum');
writeFileSync('SHA256SUMS', sums.replace(/^[a-f0-9]{64}  latest-mac\.yml$/m, `${hash}  latest-mac.yml`));
JS
gh release upload desktop-vX.Y.Z --repo vAPI-Network/vapi-network --clobber latest-mac.yml SHA256SUMS
pnpm desktop:release-verify desktop-vX.Y.Z
```

Do not change installer bytes or their hashes.
Replace both edited release assets together.
Run the release verifier from the repository checkout after the upload.

## Pause or block updates

Open a PR to `main` editing `apps/desktop/update-control.json` in this repository.
Set `paused` to `true` to stop new checks and downloads, or add an exact version to `blockedVersions`.
The updater reads the file from `main`, independently of the release tag.

```json
{ "paused": true, "blockedVersions": ["0.1.0"] }
```

Invalid or unreadable control data also prevents downloads.
Restore `paused` to `false` and remove a version block only after review.
This switch does not recall installed updates or cancel downloads already authorized.

Reproducible-build verification on a second runner, an SBOM and Windows releases remain outside this beta.
