#!/usr/bin/env node
/**
 * The only thing Claude Desktop, Cursor or VS Code run: a forwarder from MCP
 * stdio to the vAPI Desktop app's local socket. It holds no key, no config and
 * no wallet state. A hello frame names the wallet from VAPI_DESKTOP_WALLET
 * before MCP traffic. When the app is not running it starts it and retries; when
 * the app never answers it replies with one clear JSON-RPC error per request.
 */
import { spawn } from "node:child_process";
import { connect as netConnect, type Socket } from "node:net";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import type { Duplex } from "node:stream";

export type ShimOptions = {
  socketPath: string;
  wallet?: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Starts the desktop app; defaults to `open -b ai.vapinetwork.desktop` on macOS. */
  launchApp?: () => Promise<void>;
  connectAttempts?: number;
  connectDelayMs?: number;
  connect?: (path: string) => Duplex;
};

export const NOT_RUNNING_MESSAGE =
  "vAPI Desktop is not running. Open it from Applications and try again.";
export const APP_BUNDLE_ID = "ai.vapinetwork.desktop";

export function helloLine(wallet?: string): string {
  return `${JSON.stringify({ vapiDesktop: 1, wallet })}\n`;
}

function tryConnect(path: string, connect: (path: string) => Duplex): Promise<Duplex | undefined> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(undefined));
  });
}

function defaultLaunch(): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      const child = spawn("/usr/bin/open", ["-g", "-b", APP_BUNDLE_ID], { stdio: "ignore" });
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
      return;
    }
    const executable = process.env.VAPI_DESKTOP_EXECUTABLE;
    if (executable) {
      const child = spawn(executable, [], { stdio: "ignore", detached: true });
      child.unref();
    }
    resolve();
  });
}

async function connectWithLaunch(options: ShimOptions): Promise<Duplex | undefined> {
  const connect = options.connect ?? ((path: string) => netConnect(path) as Socket);
  const attempts = options.connectAttempts ?? 40;
  const delay = options.connectDelayMs ?? 500;
  const first = await tryConnect(options.socketPath, connect);
  if (first) return first;
  await (options.launchApp ?? defaultLaunch)();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const socket = await tryConnect(options.socketPath, connect);
    if (socket) return socket;
  }
  return undefined;
}

function answerNotRunning(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<void> {
  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let id: unknown;
      try {
        id = (JSON.parse(line) as { id?: unknown }).id ?? null;
      } catch {
        id = null;
      }
      output.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: NOT_RUNNING_MESSAGE } })}\n`,
      );
    });
    lines.on("close", () => resolve());
  });
}

export async function runShim(options: ShimOptions): Promise<void> {
  const socket = await connectWithLaunch(options);
  if (socket === undefined) {
    await answerNotRunning(options.input, options.output);
    return;
  }
  await new Promise<void>((resolve) => {
    socket.write(helloLine(options.wallet));
    options.input.pipe(socket);
    socket.pipe(options.output, { end: false });
    socket.once("close", () => resolve());
    options.input.once("end", () => socket.end());
  });
}

/**
 * True when `scriptPath` (argv[1]) is this module. Compares URLs, not strings:
 * `import.meta.url` is percent-encoded, and Claude Desktop installs extensions
 * under "Application Support/Claude/Claude Extensions".
 */
export function isEntryPoint(moduleUrl: string, scriptPath: string | undefined): boolean {
  if (scriptPath === undefined) return false;
  let real = scriptPath;
  try {
    // Node resolves symlinks (macOS /tmp, npm bin links) before setting import.meta.url.
    real = realpathSync(scriptPath);
  } catch {
    // A path that does not exist cannot be the running script; compare as given.
  }
  return pathToFileURL(real).href === moduleUrl;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  const socketPath = process.env.VAPI_DESKTOP_SOCKET;
  if (!socketPath) {
    process.stderr.write("VAPI_DESKTOP_SOCKET is not set.\n");
    process.exit(2);
  }
  const wallet = process.env.VAPI_DESKTOP_WALLET;
  void runShim({
    socketPath,
    input: process.stdin,
    output: process.stdout,
    ...(wallet ? { wallet } : {}),
  }).then(() => process.exit(0));
}
