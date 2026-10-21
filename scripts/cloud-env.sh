#!/usr/bin/env bash
# Source this file in each cloud shell that needs repo-prefixed variables.
# Disable tracing before expanding values, including when sourced under bash -x.
set +x

vapi_cloud_export_environment() {
  [[ "${CONDUCTOR_IS_LOCAL:-}" == "0" ]] || return 0
  local vapi_cloud_name vapi_cloud_target
  for vapi_cloud_name in "${!VAPI_NETWORK_@}"; do
    vapi_cloud_target="${vapi_cloud_name#VAPI_NETWORK_}"
    [[ "$vapi_cloud_target" =~ ^[a-zA-Z_][a-zA-Z_0-9]*$ ]] || continue
    # Assignment arguments preserve whitespace, quotes and newlines without eval.
    # An explicitly empty prefixed value also takes precedence over the fallback.
    export "$vapi_cloud_target=${!vapi_cloud_name}"
  done
}

vapi_cloud_export_environment
unset -f vapi_cloud_export_environment
