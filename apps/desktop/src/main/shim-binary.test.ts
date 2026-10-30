import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SHIM = resolve(__dirname, "../../native/out/vapi-mcp-shim");

describe.skipIf(process.platform !== "darwin")("vapi-mcp-shim", () => {
  let dir: string | undefined;
  let server: Server | undefined;
  const children = new Set<ChildProcessWithoutNullStreams>();
  const sockets = new Set<Socket>();

  function run(env: Record<string, string>, input: string[]) {
    expect(existsSync(SHIM), "run pnpm native:build").toBe(true);
    const child = spawn(SHIM, [], { env: { PATH: "/usr/bin:/bin", ...env } });
    children.add(child);
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    for (const line of input) child.stdin.write(`${line}\n`);
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  }

  async function listen(onConnection: (socket: Socket) => void) {
    dir = await mkdtemp(join(tmpdir(), "shim-bin-"));
    const socketPath = join(dir, "mcp.sock");
    server = createServer((socket) => {
      sockets.add(socket);
      onConnection(socket);
    });
    await new Promise<void>((resolveListen, reject) => {
      server?.once("error", reject);
      server?.listen(socketPath, resolveListen);
    });
    return socketPath;
  }

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((r) => child.once("close", () => r()));
        child.kill();
        await closed;
      }
    }
    children.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server?.listening) await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("is built (run pnpm native:build)", () => {
    expect(existsSync(SHIM)).toBe(true);
  });

  it("sends the hello frame with the wallet, then forwards both ways", async () => {
    const received: string[] = [];
    const socketPath = await listen((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          received.push(line);
          if (line.includes('"ping"')) socket.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
        }
      });
    });
    const { child, exited, stdout } = run(
      { VAPI_DESKTOP_SOCKET: socketPath, VAPI_DESKTOP_WALLET: "research" },
      ['{"jsonrpc":"2.0","id":1,"method":"ping"}'],
    );
    await expect.poll(stdout, { timeout: 3000 }).toBe('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    expect(received[0]).toBe('{"vapiDesktop":1,"wallet":"research"}');
    expect(received[1]).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
    child.stdin.end();
    expect(await exited).toBe(0);
  });

  it("sends a hello without a wallet when VAPI_DESKTOP_WALLET is unset", async () => {
    let resolveLine!: (line: string) => void;
    const first = new Promise<string>((r) => (resolveLine = r));
    const socketPath = await listen((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) resolveLine(buffer.split("\n")[0] ?? "");
      });
    });
    const { exited } = run({ VAPI_DESKTOP_SOCKET: socketPath }, []);
    expect(await first).toBe('{"vapiDesktop":1}');
    for (const socket of sockets) socket.end();
    expect(await exited).toBe(0);
  });

  it("answers each request with a JSON-RPC error when the app never comes up", async () => {
    dir = await mkdtemp(join(tmpdir(), "shim-bin-"));
    const { child, exited, stdout } = run(
      {
        VAPI_DESKTOP_SOCKET: join(dir, "missing.sock"),
        VAPI_DESKTOP_BUNDLE_ID: "ai.vapinetwork.desktop.test-missing",
        VAPI_DESKTOP_CONNECT_ATTEMPTS: "2",
        VAPI_DESKTOP_CONNECT_DELAY_MS: "10",
      },
      ['{"jsonrpc":"2.0","id":7,"method":"tools/list"}', '{"method":"ping"}', "invalid JSON"],
    );
    await expect.poll(() => stdout().split("\n").length, { timeout: 5000 }).toBe(4);
    expect(
      stdout()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(
      [7, null, null].map((id) => ({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: "vAPI Desktop is not running. Open it from Applications and try again.",
        },
      })),
    );
    child.stdin.end();
    expect(await exited).toBe(0);
  });

  it("exits 2 without a socket path", async () => {
    const { exited, stderr } = run({}, []);
    expect(await exited).toBe(2);
    expect(stderr()).toBe("VAPI_DESKTOP_SOCKET is not set.\n");
  });
});
