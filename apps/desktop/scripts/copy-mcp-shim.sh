#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VAPI_NETWORK_DIR="${VAPI_NETWORK_DIR:-$SCRIPT_DIR/../../..}"
RESOURCE_DIR="$SCRIPT_DIR/../resources/mcp-shim"

mkdir -p "$RESOURCE_DIR"
cp "$VAPI_NETWORK_DIR/packages/mcp-shim/dist/shim.js" "$RESOURCE_DIR/shim.js"
