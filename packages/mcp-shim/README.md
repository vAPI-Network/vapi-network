# @vapi-network/mcp-shim

The forwarder a chat app launches for vAPI Desktop, which is not released yet. It pipes MCP stdio to the vAPI Desktop
socket named by `VAPI_DESKTOP_SOCKET`, starts the app when it is not running,
and holds no key or configuration. Built into `vapi-desktop.mcpb` for Claude
Desktop with `pnpm --dir packages/mcp-shim pack:mcpb` from the repository root.

Before MCP traffic, it sends a hello frame with `vapiDesktop: 1` and the wallet
named by `VAPI_DESKTOP_WALLET` when set and non-empty.
