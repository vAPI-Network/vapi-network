/**
 * `@vapi-network/core/secrets` — the human-only corner of the SDK.
 *
 * Everything here returns a recovery phrase or a private key. It is a separate
 * package entry point, and deliberately not re-exported from the main index,
 * so that a package which must never hold a secret — the MCP server above all —
 * cannot reach one by importing `@vapi-network/core`. The repository lint rules
 * enforce that for `packages/mcp`.
 *
 * Callers must print the result to the person in front of the terminal and
 * nowhere else: not to a log, not to a file, not into a tool result.
 */
export {
  createKeystoreWithPhrase,
  decryptPrivateKey,
  exportKeystoreKeys,
  exportRecoveryPhrase,
  type ExportedVapiKeys,
} from "./keystore.js";
