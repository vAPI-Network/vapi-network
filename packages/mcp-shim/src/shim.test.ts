import { createServer, type Server } from "node:net";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { helloLine, isEntryPoint, runShim } from "./shim.js";

async function collect(output: PassThrough, lines: number): Promise<string[]> {
  const seen: string[] = [];
  let buffer = "";
  return await new Promise((resolve) => {
    output.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        seen.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        if (seen.length === lines) resolve(seen);
        index = buffer.indexOf("\n");
      }
    });
  });
}

describe("helloLine", () => {
  it("names the wallet in the hello frame", () => {
    expect(helloLine("research")).toBe('{"vapiDesktop":1,"wallet":"research"}\n');
  });

  it("omits the wallet when none is provided", () => {
    expect(helloLine()).toBe('{"vapiDesktop":1}\n');
  });
});

describe("runShim", () => {
  let directory: string;
  let server: Server | undefined;
  afterEach(async () => {
    server?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("pipes stdio to the socket and back", async () => {
    directory = await mkdtemp(join(tmpdir(), "shim-"));
    const socketPath = join(directory, "mcp.sock");
    const received: string[] = [];
    server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          received.push(line);
          if (line === '{"vapiDesktop":1,"wallet":"claude"}') continue;
          socket.write(`echo:${line}\n`);
        }
      });
    });
    await new Promise<void>((resolve) => server?.listen(socketPath, resolve));

    const input = new PassThrough();
    const output = new PassThrough();
    const done = runShim({ socketPath, input, output, wallet: "claude" });
    const replies = collect(output, 1);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(await replies).toEqual(['echo:{"jsonrpc":"2.0","id":1,"method":"ping"}']);
    expect(received[0]).toBe('{"vapiDesktop":1,"wallet":"claude"}');
    input.end();
    await done;
  });

  it("launches the app and retries when the socket is absent", async () => {
    directory = await mkdtemp(join(tmpdir(), "shim-"));
    const socketPath = join(directory, "mcp.sock");
    let launched = 0;
    const launchApp = async () => {
      launched += 1;
      server = createServer((socket) => socket.pipe(socket));
      await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const done = runShim({ socketPath, input, output, launchApp, connectDelayMs: 10 });
    const replies = collect(output, 2);
    input.write("hello\n");
    expect(await replies).toEqual(['{"vapiDesktop":1}', "hello"]);
    expect(launched).toBe(1);
    input.end();
    await done;
  });

  it("answers every request with a JSON-RPC error when the app never comes up", async () => {
    directory = await mkdtemp(join(tmpdir(), "shim-"));
    const socketPath = join(directory, "missing.sock");
    const input = new PassThrough();
    const output = new PassThrough();
    const done = runShim({
      socketPath,
      input,
      output,
      launchApp: async () => undefined,
      connectAttempts: 2,
      connectDelayMs: 5,
    });
    const replies = collect(output, 1);
    input.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
    const [reply] = await replies;
    expect(JSON.parse(reply ?? "")).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32000,
        message: "vAPI Desktop is not running. Open it from Applications and try again.",
      },
    });
    input.end();
    await done;
  });
});

describe("isEntryPoint", () => {
  it("matches a script path with spaces against its URL-encoded module URL", () => {
    // Claude Desktop installs extensions under ~/Library/Application Support/Claude/Claude Extensions.
    const path = "/Users/me/Library/Application Support/Claude/Claude Extensions/x/dist/shim.js";
    const url =
      "file:///Users/me/Library/Application%20Support/Claude/Claude%20Extensions/x/dist/shim.js";
    expect(isEntryPoint(url, path)).toBe(true);
  });

  it("resolves symlinks in the script path the way Node does for import.meta.url", async () => {
    const dir = await mkdtemp(join(tmpdir(), "shim entry "));
    const target = join(dir, "shim.js");
    const link = join(dir, "link.js");
    await writeFile(target, "");
    await symlink(target, link);
    expect(isEntryPoint(pathToFileURL(await realpath(target)).href, link)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  it("does not match when the module is imported by another script", () => {
    expect(isEntryPoint("file:///a/dist/shim.js", "/a/test.js")).toBe(false);
    expect(isEntryPoint("file:///a/dist/shim.js", undefined)).toBe(false);
  });
});
