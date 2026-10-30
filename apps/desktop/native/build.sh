#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
swiftc -O -target arm64-apple-macos13 -o out/vapi-keychain vapi-keychain/main.swift -framework Security -framework LocalAuthentication
codesign --force --sign - --entitlements entitlements.plist out/vapi-keychain
echo "built native/out/vapi-keychain"
swiftc -O -target arm64-apple-macos13 -o out/vapi-mcp-shim vapi-mcp-shim/main.swift
codesign --force --sign - out/vapi-mcp-shim
echo "built native/out/vapi-mcp-shim"
