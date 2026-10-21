#!/usr/bin/env bash
set +x
set -euo pipefail

# Direct invocation on a Mac must also leave local setup alone.
if [[ "${CONDUCTOR_IS_LOCAL:-}" != "0" ]]; then
  exit 0
fi

vapi_cloud_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$vapi_cloud_root"
# shellcheck source=scripts/cloud-env.sh
source "$vapi_cloud_root/scripts/cloud-env.sh"

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != "22" ]]; then
  printf '%s\n' 'Cloud setup requires Node.js 22; install it in the Cloud computer image and Build computer.' >&2
  exit 1
fi

# Pin to packageManager rather than accepting the image's pnpm major version.
vapi_cloud_pnpm="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager.split("@")[1]')"
if ! command -v pnpm >/dev/null || [[ "$(pnpm --version 2>/dev/null)" != "$vapi_cloud_pnpm" ]]; then
  if command -v corepack >/dev/null; then
    corepack install --global "pnpm@$vapi_cloud_pnpm"
    # The image's global npm prefix need not be on the noninteractive PATH.
    sudo "$(command -v corepack)" enable --install-directory /usr/local/bin pnpm
  else
    npm install --global "pnpm@$vapi_cloud_pnpm"
    sudo ln -sf "$(npm prefix --global)/bin/pnpm" /usr/local/bin/pnpm
  fi
  hash -r
fi

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
pnpm install --frozen-lockfile

# CI uses injected services, with no Docker images to pull or daemons to start.
# In particular, do not install or invoke Railway for its opt-in smoke test.
bash scripts/cloud-preflight.sh --strict
