import { PassThrough, type Duplex, type Readable } from "node:stream";

import { walletNameSchema } from "../shared/wallet-name.js";

export type Hello = { wallet?: string };

/** Consume a shim hello, or replay the first line for legacy MCP clients. */
export async function readHello(socket: Duplex): Promise<{ hello: Hello | null; input: Readable }> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);

    function cleanup() {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
      socket.off("close", onClose);
    }

    function finish(ended: boolean) {
      socket.pause();
      cleanup();
      let hello: Hello | null = null;
      let remainder = buffered;
      const newline = buffered.indexOf(0x0a);
      if (newline >= 0 && newline < 4096) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(buffered.subarray(0, newline).toString("utf8"));
        } catch {
          // Non-hello input belongs to the MCP server unchanged.
        }
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "vapiDesktop" in parsed &&
          parsed.vapiDesktop === 1
        ) {
          try {
            hello = "wallet" in parsed ? { wallet: walletNameSchema.parse(parsed.wallet) } : {};
          } catch (error) {
            reject(error);
            return;
          }
          remainder = buffered.subarray(newline + 1);
        }
      }
      const input = new PassThrough();
      input.write(remainder);
      if (ended) input.end();
      else socket.pipe(input);
      resolve({ hello, input });
    }

    function onData(chunk: Buffer | string) {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffered.includes(0x0a) || buffered.length >= 4096) finish(false);
    }

    function onEnd() {
      finish(true);
    }

    function onError(error: Error) {
      cleanup();
      reject(error);
    }

    function onClose() {
      onError(new Error("MCP connection closed before its first line."));
    }

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}
