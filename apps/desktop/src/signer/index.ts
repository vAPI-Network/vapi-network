import { hostname } from "node:os";

import { createSigner, type PasswordStore } from "./signer.js";
import { desktopSecretStore } from "./desktop-secret-store.js";
import { keychainPasswordStore } from "./keychain.js";
import type { RequestOrigin, SignerRequest } from "./messages.js";
import { baseBalanceReader } from "../main/overview.js";

type Envelope = { id: number; request: SignerRequest };

const home = process.env.VAPI_HOME;
const ledgerPath = process.env.VAPI_DESKTOP_SIGNER_LEDGER;
const helper = process.env.VAPI_DESKTOP_KEYCHAIN_HELPER;
const apiBase = process.env.VAPI_DESKTOP_API_BASE;
if (!home || !ledgerPath || !apiBase) {
  throw new Error("Signer started without VAPI_HOME / ledger path / API base.");
}

const password: PasswordStore = keychainPasswordStore(helper);
let reader: ReturnType<typeof baseBalanceReader> | undefined;
const signer = createSigner({
  home,
  ledgerPath,
  password,
  apiBase,
  hostname: hostname(),
  touchId: helper !== undefined,
  secrets: desktopSecretStore({ home }),
  readBalance: async (address) => {
    reader ??= baseBalanceReader(home).catch((error) => {
      reader = undefined;
      throw error;
    });
    return await (
      await reader
    )(address);
  },
});

const parentPort = process.parentPort;
const ports = new Set<Electron.MessagePortMain>();

function serve(port: Electron.MessagePortMain, origin: RequestOrigin): void {
  ports.add(port);
  port.on("message", async (event) => {
    const envelope = event.data as Envelope;
    const response = await signer.handle(envelope.request, origin);
    port.postMessage({ id: envelope.id, response });
  });
  port.start();
}

parentPort.on("message", (event) => {
  // Only an explicit UI role grants access beyond the MCP allowlist.
  const roles = (event.data as { roles?: unknown }).roles;
  event.ports.forEach((port, index) => {
    const role = Array.isArray(roles) ? roles[index] : undefined;
    serve(port, role === "ui" ? "ui" : "mcp");
  });
});
