import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { secretStore } from "./secret-store.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter & { setEncoding: () => void };
    stdin: EventEmitter & { end: ReturnType<typeof vi.fn> };
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  queueMicrotask(() => child.emit("close", 0));
  return child;
}

describe("the default secret-store runner", () => {
  it("starts the keychain tool in its own session so it reads the value from stdin", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      children.push(child);
      return child;
    });

    await secretStore({ platform: "darwin" }).set("main", "correct horse");

    const call = spawnMock.mock.calls.find((c) =>
      (c[1] as string[]).includes("add-generic-password"),
    );
    expect(call).toBeDefined();
    expect(call?.[0]).toBe("/usr/bin/security");
    expect(call?.[2]).toMatchObject({
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(call?.[1]).not.toContain("correct horse");
    const index = spawnMock.mock.calls.indexOf(call!);
    expect(children[index]?.stdin.end).toHaveBeenCalledWith(
      expect.stringContaining("correct horse"),
    );
  });
});
