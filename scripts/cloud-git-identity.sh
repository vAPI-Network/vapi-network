#!/usr/bin/env bash
set +x
set -euo pipefail

# Write the project identity into this checkout's git config in a cloud workspace.
# cloud-env.sh exports GIT_AUTHOR_* through BASH_ENV, which only non-interactive
# Bash reads. An agent that starts git from another shell, or directly, would
# otherwise commit as the account that started the workspace.
if [[ "${CONDUCTOR_IS_LOCAL:-}" != "0" ]]; then
  exit 0
fi

git rev-parse --git-dir >/dev/null 2>&1 || exit 0
git config --local user.name 'vAPI Development'
git config --local user.email '336934719+vapi-development@users.noreply.github.com'
