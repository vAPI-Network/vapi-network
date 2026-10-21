#!/usr/bin/env bash
# Loaded through cloud BASH_ENV, or sourced explicitly in an existing shell.
# Disable tracing before expanding values, then restore the caller's state.
case $- in
  *x*) set +x; vapi_cloud_restore_xtrace=1 ;;
  *) vapi_cloud_restore_xtrace=0 ;;
esac

vapi_cloud_export_environment() {
  [[ "${CONDUCTOR_IS_LOCAL:-}" == "0" ]] || return 0
  [[ "${VAPI_NETWORK_CLOUD_ENV_APPLIED:-}" != "1" ]] || return 0
  local vapi_cloud_name vapi_cloud_target

  # The shared cloud environment may contain another repo's plain variables.
  # None of these owned names are non-secret defaults in settings.toml;
  # NODE_OPTIONS and BASH_ENV from [environment_variables.cloud] stay intact.
  for vapi_cloud_name in "${!VAPI_@}" BASE_RPC_URL ARC_RPC_URL ARC_TESTNET_RPC_URL SOLANA_RPC_URL; do
    [[ "$vapi_cloud_name" == VAPI_NETWORK_* ]] && continue
    unset "$vapi_cloud_name"
  done

  for vapi_cloud_name in "${!VAPI_NETWORK_@}"; do
    [[ "$vapi_cloud_name" == VAPI_NETWORK_CLOUD_ENV_APPLIED ]] && continue
    vapi_cloud_target="${vapi_cloud_name#VAPI_NETWORK_}"
    [[ "$vapi_cloud_target" =~ ^[a-zA-Z_][a-zA-Z_0-9]*$ ]] || continue
    # Assignment arguments preserve whitespace, quotes and newlines without eval.
    export "$vapi_cloud_target=${!vapi_cloud_name}"
  done
  # Descendants inherit this guard so caller overrides survive nested shells.
  export VAPI_NETWORK_CLOUD_ENV_APPLIED=1
}

vapi_cloud_export_environment
unset -f vapi_cloud_export_environment
if [[ "$vapi_cloud_restore_xtrace" == "1" ]]; then
  unset vapi_cloud_restore_xtrace
  set -x
else
  unset vapi_cloud_restore_xtrace
fi
