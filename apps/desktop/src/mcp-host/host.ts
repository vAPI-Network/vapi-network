import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { loadConfig, remotePaymentAccount, type VapiConfig } from "@vapi-network/core";
import { createVapiServer } from "@vapi-network/mcp";

import { readHello } from "./hello.js";
import type { SignerRequest, SignerResponse, WalletSummary } from "../signer/messages.js";

export type SignerRequester = (request: SignerRequest) => Promise<SignerResponse>;

export type McpHostDeps = {
  socketPath: string;
  home: string;
  /** Fallback when a connection has no wallet hello; defaults to the first agent wallet. */
  wallet?: string;
  signer: SignerRequester;
  env?: NodeJS.ProcessEnv;
};

async function walletFacts(deps: McpHostDeps, name: string | undefined): Promise<WalletSummary> {
  const response = await deps.signer({ type: "listWallets" });
  if (!response.ok || response.type !== "listWallets") {
    throw new Error(response.ok ? "unexpected signer reply" : response.message);
  }
  const wallet =
    name === undefined
      ? response.wallets[0]
      : response.wallets.find((entry) => entry.name === name);
  if (wallet === undefined) {
    throw new Error(
      name === undefined
        ? "Create an agent wallet in vAPI Desktop first."
        : `The agent wallet "${name}" is not in vAPI Desktop. Reconnect this app from vAPI Desktop.`,
    );
  }
  return wallet;
}

function accountFor(deps: McpHostDeps, wallet: WalletSummary) {
  return remotePaymentAccount({
    wallet: wallet.name,
    address: wallet.address,
    publicKey: wallet.publicKey,
    request: async (message) => {
      const response = await deps.signer({
        type: "sign",
        wallet: message.wallet,
        request:
          message.kind === "typedData"
            ? { kind: "typedData", typedData: message.typedData }
            : { kind: "message", message: message.message },
      });
      if (!response.ok) throw new Error(response.message);
      if (response.type !== "sign") throw new Error("unexpected signer reply");
      return response.signature;
    },
  });
}

async function serveConnection(
  socket: Socket,
  deps: McpHostDeps,
  config: VapiConfig,
): Promise<void> {
  const { hello, input } = await readHello(socket);
  const wallet = await walletFacts(deps, hello?.wallet ?? deps.wallet);
  const server = createVapiServer({
    account: accountFor(deps, wallet),
    config,
    wallet: wallet.name,
    env: deps.env ?? process.env,
    ledgerPath: join(deps.home, "spend-ledger.json"),
    receiptsPath: join(deps.home, "receipts.jsonl"),
    searchesPath: join(deps.home, "searches.jsonl"),
  });
  server.connect(input, socket);
  socket.on("close", () => void server.close());
}

export async function createMcpHost(deps: McpHostDeps): Promise<{ close(): Promise<void> }> {
  const config = await loadConfig(join(deps.home, "config.json"), deps.env ?? process.env);
  await mkdir(dirname(deps.socketPath), { recursive: true, mode: 0o700 });
  await rm(deps.socketPath, { force: true });
  const server: Server = createServer((socket) => {
    // A shim that dies mid-session resets the socket; that must not take the host down.
    socket.on("error", () => socket.destroy());
    serveConnection(socket, deps, config).catch((error: unknown) => {
      if (socket.destroyed) return;
      socket.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })}\n`,
      );
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.socketPath, () => resolve());
  });
  await chmod(deps.socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
