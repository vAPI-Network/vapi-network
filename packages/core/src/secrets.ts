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

// Recovery phrases and private keys stay on the human-only secrets entry point.
export { exportMemberKey, exportVaultAccountKey, exportVaultPhrase } from "./vault.js";
// A member bundle carries one member account's own private key to a sandbox.
export {
  createMemberBundle,
  headlessConfigFromBundle,
  MEMBER_BUNDLE_MAX_BYTES,
  MemberBundleError,
  memberBundleConfig,
  memberBundleConfigSchema,
  memberBundleSchema,
  openMemberBundle,
  readMemberCredentials,
  type MemberBundle,
  type MemberBundleConfig,
  type MemberBundleErrorCode,
  type MemberBundleNetwork,
  type MemberCredentials,
} from "./member-bundle.js";
