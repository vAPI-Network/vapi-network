import { createMcpHost, type SignerRequester } from "./host.js";
import type { SignerRequest, SignerResponse } from "../signer/messages.js";

const socketPath = process.env.VAPI_DESKTOP_SOCKET;
const home = process.env.VAPI_HOME;
const wallet = process.env.VAPI_DESKTOP_WALLET;
if (!socketPath || !home) throw new Error("MCP host started without socket path / VAPI_HOME.");

let nextId = 1;
const pending = new Map<number, (response: SignerResponse) => void>();
let signerPort: Electron.MessagePortMain | undefined;

const signer: SignerRequester = (request: SignerRequest) =>
  new Promise((resolve, reject) => {
    if (signerPort === undefined) return reject(new Error("Signer not connected."));
    const id = nextId++;
    pending.set(id, resolve);
    signerPort.postMessage({ id, request });
  });

process.parentPort.on("message", (event) => {
  const [port] = event.ports;
  if (!port) return;
  signerPort = port;
  port.on("message", (reply) => {
    const { id, response } = reply.data as { id: number; response: SignerResponse };
    pending.get(id)?.(response);
    pending.delete(id);
  });
  port.start();
  void createMcpHost({ socketPath, home, signer, ...(wallet === undefined ? {} : { wallet }) });
});
