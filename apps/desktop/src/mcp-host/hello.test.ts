import { PassThrough, type Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { readHello } from "./hello.js";

async function bytes(input: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("readHello", () => {
  it("consumes a hello and preserves MCP in the same chunk", async () => {
    const socket = new PassThrough();
    const reading = readHello(socket);
    socket.end('{"vapiDesktop":1,"wallet":"research"}\n{"jsonrpc":"2.0","id":1}\n');
    const { hello, input } = await reading;
    expect(hello).toEqual({ wallet: "research" });
    expect(await bytes(input)).toEqual(Buffer.from('{"jsonrpc":"2.0","id":1}\n'));
  });

  it("reads a hello split across chunks and forwards subsequent chunks", async () => {
    const socket = new PassThrough();
    const reading = readHello(socket);
    socket.write('{"vapiDes');
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.write('ktop":1}\n{"js');
    const { hello, input } = await reading;
    socket.end('onrpc":"2.0"}\n');
    expect(hello).toEqual({});
    expect(await bytes(input)).toEqual(Buffer.from('{"jsonrpc":"2.0"}\n'));
  });

  it("replays a legacy first line byte-for-byte", async () => {
    const socket = new PassThrough();
    const legacy = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    const reading = readHello(socket);
    socket.end(legacy);
    const { hello, input } = await reading;
    expect(hello).toBeNull();
    expect(await bytes(input)).toEqual(legacy);
  });

  it("rejects a hello with an empty wallet", async () => {
    const socket = new PassThrough();
    const reading = readHello(socket);
    socket.end('{"vapiDesktop":1,"wallet":""}\n');
    await expect(reading).rejects.toThrow();
  });

  it("stops waiting after 4096 bytes without a newline and replays them", async () => {
    const socket = new PassThrough();
    const oversized = Buffer.alloc(4097, "x");
    const reading = readHello(socket);
    socket.write(oversized);
    const { hello, input } = await reading;
    socket.end("\nnext\n");
    expect(hello).toBeNull();
    expect(await bytes(input)).toEqual(Buffer.concat([oversized, Buffer.from("\nnext\n")]));
  });
});
