# apps/desktop: Agent Guide

Local deltas for vAPI Desktop (Electron). Repo-wide rules live in the root
[AGENTS.md](../../AGENTS.md). Run commands below from the repository root.

- Three processes: `src/signer` is the only code that may import `WalletStore`
  or anything that returns a key. `src/mcp-host` and `src/renderer` never do.
- Every BrowserWindow comes from `windowOptions()`; `window.test.ts` asserts
  the hardening flags. Do not construct windows elsewhere.
- Secrets: `desktopSecretStore` keeps `vault-key`/`vault-session` in memory and
  link tokens in the OS store. Tests pass `memorySecretStore()` as `secrets`;
  never let a test reach the real Keychain.
- UI copy says "vAPI Desktop", "agent wallet", "Emergency Kit"; never "vault"
  or "keystore".
- No remote content in the renderer. No telemetry.
- Every app config points at the native shim (`Resources/vapi-mcp-shim`, built
  by the native build) except Claude Desktop, whose generated `.mcpb` packs
  the Node shim from `resources/mcp-shim/shim.js`. The desktop build and tests
  generate the Node shim. Build the native shim before tests; socket tests spawn it.

  ```sh
  pnpm --dir apps/desktop native:build
  pnpm --dir apps/desktop resources:shim
  pnpm --dir apps/desktop test
  ```

- The MCP host's signer port allows only `status`, `listWallets` and `sign`
  (`MCP_REQUEST_TYPES` in `src/signer/messages.ts`). Add a message there only
  if the MCP host needs it; Emergency Kit, restore and backup messages never.
- The signer signs plain messages only as SIWE sign-ins for the configured
  vAPI server (`src/signer/siwe-policy.ts`). Never widen it to a general
  message signer; new signing needs get their own typed request.
- Crash reports are local, opt-in (`preferences.json`) and scrubbed
  (`src/main/crash-log.ts`). Never start Electron's `crashReporter`:
  minidumps hold process memory.
- Check renderer copy with the desktop checker. Repository documentation has
  its own copy lint.

  ```sh
  pnpm --dir apps/desktop check:copy
  pnpm lint:copy
  ```

- Packaging checks fuses from `scripts/fuses.cjs`, signature, helpers and
  minimum macOS 13. Signing, notarization and updates switch on only with
  the environment variables in [RELEASE.md](RELEASE.md).

  ```sh
  pnpm --dir apps/desktop pack:mac
  pnpm --dir apps/desktop check:packaged
  ```
