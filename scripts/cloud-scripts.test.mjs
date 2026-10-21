import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const settings = readFileSync(join(root, ".conductor/settings.toml"), "utf8");
const bash = spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
// Exercise the actual startup-file and setup strings shipped to Conductor.
const bashEnv = settings.match(/^BASH_ENV = '([^']+)'$/m)?.[1];
const nodeOptions = settings.match(/^NODE_OPTIONS = "([^"]+)"$/m)?.[1];
const setup = settings.match(/^setup = '''\n([\s\S]*?)\n'''$/m)?.[1];
assert.ok(bashEnv);
assert.ok(nodeOptions);
assert.ok(setup);

function shell(command, env = {}, args = [], cwd = root) {
  return spawnSync(bash, [...args, "-c", command], {
    cwd,
    encoding: "utf8",
    // Node's stdin socket can trigger Bash's remote-shell .bashrc path.
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: tmpdir(),
      CONDUCTOR_IS_LOCAL: "0",
      CONDUCTOR_WORKSPACE_PATH: root,
      BASH_ENV: bashEnv,
      NODE_OPTIONS: nodeOptions,
      ...env,
    },
  });
}

function passed(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "vapi-cloud-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("a plain sibling value is ignored", () => {
  const names = [
    "VAPI_API_KEY",
    "VAPI_VAULT_PASSWORD",
    "VAPI_PRIVATE_KEY",
    "VAPI_WALLET",
    "VAPI_REGISTRY_URL",
    "VAPI_DISCOVERY_URL",
    "VAPI_MARKETPLACE_DISCOVERY_URL",
    "VAPI_DOCS_URL",
    "VAPI_KEYSTORE_PASSWORD",
    "BASE_RPC_URL",
    "BASE_SEPOLIA_RPC_URL",
    "ARC_RPC_URL",
    "ARC_TESTNET_RPC_URL",
    "SOLANA_RPC_URL",
  ];
  passed(
    shell(
      `for name in ${names.join(" ")}; do [[ -z "\${!name+x}" ]] || exit 1; done
       [[ "$NODE_OPTIONS" == '--max-old-space-size=8192' && -n "$BASH_ENV" ]]
       [[ "$VAPI_NETWORK_CLOUD_ENV_APPLIED" == 1 ]]`,
      Object.fromEntries(names.map((name) => [name, "sibling-value"])),
    ),
  );
});

test("prefixed values map literally, including empty values, without tracing secrets", () => {
  const secret = "literal-secret-'\" $(exit 91) `exit 92`\nsecond line";
  const result = shell(
    `[[ "$VAPI_API_KEY" == "$VAPI_NETWORK_VAPI_API_KEY" ]] || exit 1
     [[ -n "\${VAPI_VAULT_PASSWORD+x}" && -z "$VAPI_VAULT_PASSWORD" ]] || exit 1
     [[ "$ARC_TESTNET_RPC_URL" == "$VAPI_NETWORK_ARC_TESTNET_RPC_URL" ]] || exit 1
     [[ "$BASE_SEPOLIA_RPC_URL" == "$VAPI_NETWORK_BASE_SEPOLIA_RPC_URL" ]] || exit 1`,
    {
      VAPI_API_KEY: "sibling-value",
      VAPI_NETWORK_VAPI_API_KEY: secret,
      VAPI_NETWORK_VAPI_VAULT_PASSWORD: "",
      VAPI_NETWORK_ARC_TESTNET_RPC_URL: "https://rpc.invalid/",
      BASE_SEPOLIA_RPC_URL: "https://sibling.invalid/",
      VAPI_NETWORK_BASE_SEPOLIA_RPC_URL: "https://repo-sepolia.invalid/",
    },
  );
  passed(result);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("BASH_ENV loads from any working directory, including a workspace path with spaces", (t) => {
  const directory = temporaryDirectory(t);
  const workspace = join(directory, "workspace with spaces");
  symlinkSync(root, workspace, "dir");
  passed(
    shell(
      '[[ "$VAPI_API_KEY" == repo-value ]]',
      {
        CONDUCTOR_WORKSPACE_PATH: workspace,
        VAPI_NETWORK_VAPI_API_KEY: "repo-value",
      },
      [],
      directory,
    ),
  );
});

test("a nested bash -c keeps a caller-set value and does not reapply mappings", () => {
  passed(
    shell(
      `export VAPI_API_KEY=caller-value
       source scripts/cloud-env.sh
       [[ "$VAPI_API_KEY" == caller-value ]] || exit 1
       bash -c '[[ "$VAPI_API_KEY" == caller-value ]]' || exit 1
       VAPI_API_KEY=child-value bash -c '[[ "$VAPI_API_KEY" == child-value ]]' || exit 1
       unset VAPI_API_KEY
       bash -c '[[ -z "\${VAPI_API_KEY+x}" ]]'`,
      { VAPI_NETWORK_VAPI_API_KEY: "repo-value" },
    ),
  );
});

test("the helper restores xtrace without exposing mapped values", () => {
  const result = shell(
    `[[ $- == *x* ]] || exit 1
     set +x
     [[ "$VAPI_API_KEY" == "$VAPI_NETWORK_VAPI_API_KEY" ]] || exit 1
     set -x
     source scripts/cloud-env.sh
     [[ $- == *x* ]] || exit 1
     printf '%s\\n' tracing-restored`,
    { VAPI_NETWORK_VAPI_API_KEY: "secret-trace-canary" },
    ["-x"],
  );
  passed(result);
  assert.match(result.stderr, /printf.*tracing-restored/);
  assert.doesNotMatch(result.stderr, /secret-trace-canary/);
  passed(shell("source scripts/cloud-env.sh; [[ $- != *x* ]]"));
});

test("local and unknown environments preserve plain values and setup does nothing", (t) => {
  const directory = temporaryDirectory(t);
  // If either setup path tries to install anything, fail without running pnpm.
  writeFileSync(join(directory, "pnpm"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  for (const local of ["1", undefined]) {
    const env = {
      CONDUCTOR_IS_LOCAL: local,
      VAPI_API_KEY: "local-value",
      VAPI_NETWORK_VAPI_API_KEY: "cloud-value",
      PATH: directory,
    };
    passed(
      shell(
        `source scripts/cloud-env.sh
         [[ "$VAPI_API_KEY" == local-value && -z "\${VAPI_NETWORK_CLOUD_ENV_APPLIED+x}" ]]`,
        env,
      ),
    );
    passed(shell(setup, env));
    passed(shell("source scripts/cloud-setup.sh", env));
  }
});

test("preflight checks prefixed names and never requests optional missing inputs", () => {
  const result = shell("bash scripts/cloud-preflight.sh", {
    VAPI_API_KEY: "sibling-key",
    VAPI_VAULT_PASSWORD: "sibling-password",
    ARC_TESTNET_RPC_URL: "https://sibling.invalid/",
  });
  passed(result);
  for (const name of ["VAPI_API_KEY", "VAPI_VAULT_PASSWORD", "ARC_TESTNET_RPC_URL"]) {
    assert.match(result.stdout, new RegExp(`L2: ${name} \\(.*\\) \\| optional, unset \\| —`));
  }
  assert.doesNotMatch(result.stdout + result.stderr, /needs:|sibling-key|sibling-password/);

  const prefixed = shell("bash scripts/cloud-preflight.sh", {
    VAPI_NETWORK_VAPI_API_KEY: "repo-key",
    VAPI_NETWORK_VAPI_VAULT_PASSWORD: "",
    VAPI_NETWORK_ARC_TESTNET_RPC_URL: "https://repo.invalid/",
  });
  passed(prefixed);
  assert.match(prefixed.stdout, /L2: VAPI_API_KEY \(.*\) \| set \|/);
  assert.match(prefixed.stdout, /L2: VAPI_VAULT_PASSWORD \(.*\) \| optional, unset \|/);
  assert.match(prefixed.stdout, /L2: ARC_TESTNET_RPC_URL \(.*\) \| set \|/);
  assert.doesNotMatch(prefixed.stdout + prefixed.stderr, /repo-key|https:\/\/repo.invalid/);
});

test("preflight remains advisory by default and strict for level 1 failures", () => {
  const env = { NODE_OPTIONS: "--max-old-space-size=128" };
  const advisory = shell("bash scripts/cloud-preflight.sh", env);
  passed(advisory);
  assert.match(advisory.stdout, /L1: Node heap ≥8192 MiB \| FAIL/);
  const strict = shell("bash scripts/cloud-preflight.sh --strict", env);
  assert.equal(strict.status, 1);
  assert.equal(shell("bash scripts/cloud-preflight.sh --invalid").status, 2);
});
