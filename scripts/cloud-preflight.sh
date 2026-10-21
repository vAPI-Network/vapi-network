#!/usr/bin/env bash
set +x
set -euo pipefail

vapi_cloud_strict=0
if [[ "$#" == "1" && "$1" == "--strict" ]]; then
  vapi_cloud_strict=1
elif [[ "$#" != "0" ]]; then
  printf '%s\n' 'Usage: bash scripts/cloud-preflight.sh [--strict]' >&2
  exit 2
fi

vapi_cloud_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$vapi_cloud_root"
# shellcheck source=scripts/cloud-env.sh
source "$vapi_cloud_root/scripts/cloud-env.sh"
vapi_cloud_failed=0

vapi_cloud_row() {
  printf '| %s | %s | %s |\n' "$1" "$2" "$3"
}

vapi_cloud_tool() {
  if command -v "$1" >/dev/null; then
    vapi_cloud_row "L1: $1" pass '—'
  else
    vapi_cloud_row "L1: $1" FAIL "$2"
    vapi_cloud_failed=1
  fi
}

vapi_cloud_optional_env() {
  local vapi_cloud_key="$1"
  local vapi_cloud_prefixed_key="VAPI_NETWORK_$vapi_cloud_key"
  if [[ -n "${!vapi_cloud_prefixed_key:-}" ]]; then
    vapi_cloud_row "L2: $vapi_cloud_key ($2)" set '—'
  else
    vapi_cloud_row "L2: $vapi_cloud_key ($2)" 'optional, unset' '—'
  fi
}

printf '%s\n' '| check | status | how to fix |' '| --- | --- | --- |'
for vapi_cloud_tool_name in bash git npm; do
  vapi_cloud_tool "$vapi_cloud_tool_name" "Install $vapi_cloud_tool_name in the Cloud computer image, then Build computer."
done

if command -v node >/dev/null && [[ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" == "22" ]]; then
  vapi_cloud_row 'L1: Node.js 22' pass '—'
else
  vapi_cloud_row 'L1: Node.js 22' FAIL 'Install Node.js 22 in the Cloud computer image, then Build computer.'
  vapi_cloud_failed=1
fi

vapi_cloud_pnpm='10.27.0'
if command -v node >/dev/null; then
  vapi_cloud_pnpm="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager.split("@")[1]' 2>/dev/null)" || vapi_cloud_pnpm='10.27.0'
fi
if command -v pnpm >/dev/null && [[ "$(pnpm --version 2>/dev/null)" == "$vapi_cloud_pnpm" ]]; then
  vapi_cloud_row "L1: pnpm $vapi_cloud_pnpm" pass '—'
else
  vapi_cloud_row "L1: pnpm $vapi_cloud_pnpm" FAIL 'Run bash scripts/cloud-setup.sh.'
  vapi_cloud_failed=1
fi

if [[ -x node_modules/.bin/tsc && -x node_modules/.bin/vitest && -x node_modules/.bin/eslint && -x node_modules/.bin/prettier && -x node_modules/.bin/esbuild ]]; then
  vapi_cloud_row 'L1: workspace dependencies' pass '—'
else
  vapi_cloud_row 'L1: workspace dependencies' FAIL 'Run pnpm install --frozen-lockfile.'
  vapi_cloud_failed=1
fi

# Query V8 instead of printing NODE_OPTIONS, which might contain private paths.
vapi_cloud_heap=0
if command -v node >/dev/null; then
  vapi_cloud_heap="$(node -e 'console.log(Math.floor(require("node:v8").getHeapStatistics().heap_size_limit / 1024 / 1024))' 2>/dev/null)" || vapi_cloud_heap=0
fi
if [[ "$vapi_cloud_heap" =~ ^[0-9]+$ ]] && (( vapi_cloud_heap >= 8192 )); then
  vapi_cloud_row 'L1: Node heap ≥8192 MiB' pass '—'
else
  vapi_cloud_row 'L1: Node heap ≥8192 MiB' FAIL 'Use cloud NODE_OPTIONS=--max-old-space-size=8192 from .conductor/settings.toml.'
  vapi_cloud_failed=1
fi
vapi_cloud_row 'L1: test services / Docker images' 'not required' 'CI uses injected services; no Postgres, Redis, anvil or Docker daemon is needed.'
vapi_cloud_row 'L2: self-check secrets' 'not required' 'All seven CI commands run without credentials or a funded wallet.'
vapi_cloud_optional_env VAPI_API_KEY 'manual publishing only'
vapi_cloud_optional_env VAPI_VAULT_PASSWORD 'existing vault only'
vapi_cloud_optional_env ARC_TESTNET_RPC_URL 'Arc testnet only'
vapi_cloud_row 'L2: live smoke tests' 'excluded from CI' 'Leave VAPI_RUNTIME_SMOKE and VAPI_RAILWAY_SMOKE unset; never run Railway writes from cloud.'

if (( vapi_cloud_strict && vapi_cloud_failed )); then
  exit 1
fi
