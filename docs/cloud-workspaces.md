# Cloud workspaces

Run `bash scripts/cloud-preflight.sh` first. It prints one table, shows variable
names only, and exits 0 by default. `--strict` exits 1 when a level 1 check fails;
optional level 2 credentials do not block CI. Report `needs:` rows rather than
substituting mock credentials. Tool failures have installation instructions.

Conductor's shared setup calls `bash scripts/cloud-setup.sh` only when
`CONDUCTOR_IS_LOCAL=0`. Local setup is a no-op, as it was before this configuration.
Cloud setup selects the pinned pnpm version, installs dependencies with the frozen
lockfile, checks the environment, and starts no services. Node.js 22, npm, Git,
Bash and passwordless sudo are supplied by the cloud image. The cloud-only
`NODE_OPTIONS` setting allows an 8 GiB heap; this repo's baseline also passed
with Node's default heap. Setup is safe to rerun.

The organization cloud environment is shared across repositories. Add this repo's
variables as `VAPI_NETWORK_<NAME>` in Conductor: Settings → Cloud computer →
Environment, then Build computer. For example, `VAPI_NETWORK_ARC_TESTNET_RPC_URL`
maps to `ARC_TESTNET_RPC_URL`. Only prefixed values are mapped, including explicitly
empty values. On first cloud entry the helper unsets inherited plain `VAPI_*`
names (except the `VAPI_NETWORK_*` inputs) and `BASE_RPC_URL`, `ARC_RPC_URL`,
`ARC_TESTNET_RPC_URL`, and `SOLANA_RPC_URL`. A sibling repository's plain credentials
or RPC settings are never used. Non-secret defaults declared in
`[environment_variables.cloud]` (`NODE_OPTIONS` and `BASH_ENV`) are retained.

Cloud `BASH_ENV` points to the helper using `CONDUCTOR_WORKSPACE_PATH`, so every
new non-interactive Bash shell loads it, even from a subdirectory. An exported
`VAPI_NETWORK_CLOUD_ENV_APPLIED=1` sentinel applies mapping once per process tree;
later sourcing and nested shells preserve any value the caller sets for a child.
For an existing cloud shell that predates this configuration, initialize it with:

```sh
source scripts/cloud-env.sh
```

The helper does nothing locally, never evaluates values as shell code, and turns
off shell tracing before expanding them, then restores the caller's tracing state.
The repo does not load a `.env` file, so
setup does not create one or persist secrets on disk. Do not put secrets in TOML.
An existing `.conductor/settings.local.toml` can override shared setup; retain it
locally as needed, and use the shared setup for new cloud workspaces.

CI runs these commands in order on Node.js 22 with pnpm 10.27.0:

```sh
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

There is no separate CI integration job or required daemon, Docker image,
credential, wallet or live network for tests. `pack:check` builds again and
verifies staged tarballs without publishing. The two `VAPI_RUNTIME_SMOKE=1`
tests spawn local processes; `VAPI_RAILWAY_SMOKE=1` creates and destroys remote
infrastructure. All three are opt-in and excluded from the canonical self-check.
Never enable the Railway smoke test, deploy, or touch production from cloud.

Level 2 rows are optional environment inputs for specific app operations:

| Variable            | Needed for                                            |
| ------------------- | ----------------------------------------------------- |
| VAPI_API_KEY        | Human registry publishing; not needed for development |
| VAPI_VAULT_PASSWORD | Unlocking an existing vault; not needed for tests     |
| ARC_TESTNET_RPC_URL | Arc testnet operations, which have no default RPC     |

These rows check the prefixed environment names only, not plain sibling values,
OS secret-store or configuration fallbacks. Missing optional inputs show
`optional, unset` without a `needs:` request. No credentials need to be added to run CI. Other networks
have public RPC defaults; overrides also support the same prefix mapping. Do not
provision a funded wallet or add production credentials for this self-check.

Run `pnpm test:scripts` for deterministic isolated-shell regression tests; it also
runs as part of `pnpm test`. Validate shell syntax with
`bash -n scripts/cloud-{env,setup,preflight}.sh` and use ShellCheck when available.
