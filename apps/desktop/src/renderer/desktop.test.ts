// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { RestoreFromBackup } from "./screens/Restore.js";
import { Unlock } from "./screens/Unlock.js";
import { useOverview } from "./useOverview.js";

vi.mock("./screens/Shell.js", () => ({ Shell: () => createElement("p", null, "Home") }));
vi.mock("./ui/Logo.js", () => ({
  DesktopBrand: () => null,
  BootLoader: () => createElement("p", null, "Boot overlay"),
}));

let container: HTMLDivElement;
let root: Root;
const signer = vi.fn();
const overview = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      signer: signer.mockReset(),
      overview: overview.mockReset(),
      custodyAccepted: async () => true,
      openConsole: vi.fn().mockResolvedValue({ opened: true }),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(node: ReactNode) {
  await act(async () => root.render(node));
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("leaves a consumed backup approval after failure and requests a fresh code", async () => {
  signer.mockImplementation(async (request) => {
    if (request.type === "backupStart")
      return {
        ok: true,
        type: request.type,
        result: {
          mode: "browser",
          code: "123456",
          url: "https://api.vapinetwork.ai/agents",
          expiresAt: 99999,
        },
      };
    if (request.type === "backupPoll")
      return {
        ok: true,
        type: request.type,
        result: {
          state: "approved",
          owner: "0x1234567890",
        },
      };
    return { ok: false, code: "error", message: "Could not download backup." };
  });
  const onBack = vi.fn();
  await render(createElement(RestoreFromBackup, { onBack, onRestored: vi.fn() }));
  await click("Get a code");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  for (const field of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
    await input(field, "long enough password");
  }
  await click("Restore");
  expect(container.textContent).toContain("Could not download backup.");
  expect(container.querySelector("form")).toBeNull();
  await click("Start again");
  expect(signer.mock.calls.filter(([request]) => request.type === "backupStart")).toHaveLength(2);
  await click("Back");
  expect(onBack).toHaveBeenCalledOnce();
});

it("clears the boot overlay when the overview transport rejects", async () => {
  signer.mockResolvedValue({ ok: true, type: "status", vault: "unlocked", touchId: false });
  overview.mockRejectedValue(new Error("Overview unavailable."));
  await render(createElement(App));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1400);
  });
  expect(container.textContent).toContain("Home");
  expect(container.textContent).not.toContain("Boot overlay");
});

it("records rejected overview requests and clears the error after a successful retry", async () => {
  const data = { owner: null, recovery: null, wallets: [], activity: [], apps: [] };
  overview
    .mockRejectedValueOnce(new Error("Overview unavailable."))
    .mockResolvedValue({ ok: true, ...data });
  let current: ReturnType<typeof useOverview>;
  function Harness() {
    current = useOverview(15000);
    return createElement("p", null, current.error ?? "No error");
  }
  await render(createElement(Harness));
  expect(container.textContent).toContain("Overview unavailable.");
  await act(async () => current.refresh());
  expect(container.textContent).toBe("No error");
  expect(current!.overview).toEqual(data);
});

it.each([
  ["password_required", "That password is not right."],
  ["error", "Secret store unavailable."],
  ["no_vault", "No setup on this Mac."],
])("preserves the signer's %s unlock message", async (code, message) => {
  signer.mockResolvedValue({ ok: false, code, message });
  await render(createElement(Unlock, { onUnlocked: vi.fn() }));
  await input(container.querySelector("input")!, "password");
  await click("Unlock");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
});

it("uses the shared 32-character name rule during onboarding", async () => {
  const { Onboarding } = await import("./screens/Onboarding.js");
  signer.mockResolvedValue({ ok: true, type: "createVault" });
  await render(
    createElement(Onboarding, { start: "protect", onDone: vi.fn(), onRestore: vi.fn() }),
  );
  for (const field of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
    await input(field, "long enough password");
  }
  await click("Continue");
  const name = container.querySelector("input")!;
  await input(name, "a".repeat(33));
  await click("Create agent wallet");
  expect(signer).not.toHaveBeenCalledWith(expect.objectContaining({ type: "createWallet" }));
  await input(name, "a".repeat(32));
  await click("Create agent wallet");
  expect(signer).toHaveBeenCalledWith({
    type: "createWallet",
    name: "a".repeat(32),
    caps: {
      perCallAtomic: "1000000",
      perDayAtomic: "5000000",
    },
  });
});

it("uses the same wallet-name rule and defaults from Home's new wallet screen", async () => {
  const { Shell } =
    await vi.importActual<typeof import("./screens/Shell.js")>("./screens/Shell.js");
  const data = { owner: null, recovery: null, wallets: [], activity: [], apps: [] };
  overview.mockResolvedValue({ ok: true, ...data });
  signer.mockResolvedValue({ ok: false, code: "error", message: "Test creation stopped." });
  await render(createElement(Shell, { initial: data, onLocked: vi.fn() }));
  await click("New agent wallet");
  const name = container.querySelector("input")!;
  await input(name, "a".repeat(33));
  await click("Create agent wallet");
  expect(signer).not.toHaveBeenCalled();
  await input(name, "a".repeat(32));
  await click("Create agent wallet");
  expect(signer).toHaveBeenCalledWith({
    type: "createWallet",
    name: "a".repeat(32),
    caps: {
      perCallAtomic: "1000000",
      perDayAtomic: "5000000",
    },
  });
});

it("awaits clipboard success, reports failures and resets feedback after two seconds", async () => {
  const { useCopyText } = await import("./useCopyText.js");
  const copyText = vi.fn();
  window.desktop.copyText = copyText;
  let finish!: () => void;
  copyText.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  function Harness() {
    const { copy, copied, error } = useCopyText();
    return createElement(
      "button",
      { onClick: () => void copy("config") },
      error ? "Error" : copied ? "Copied" : "Copy",
    );
  }
  await render(createElement(Harness));
  await click("Copy");
  expect(container.textContent).toBe("Copy");
  await act(async () => finish());
  expect(container.textContent).toBe("Copied");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1999);
  });
  expect(container.textContent).toBe("Copied");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(container.textContent).toBe("Copy");
  copyText.mockRejectedValueOnce(new Error("Clipboard unavailable."));
  await click("Copy");
  expect(container.textContent).toBe("Error");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(container.textContent).toBe("Copy");
});

it.each(["enroll", "restore"] as const)(
  "polls the %s relay without overlapping requests and stops on completion",
  async (purpose) => {
    const { useBackupRelay } = await import("./useBackupRelay.js");
    let poll!: (value: unknown) => void;
    signer.mockImplementation(async (request) =>
      request.type === "backupStart"
        ? {
            ok: true,
            type: "backupStart",
            result: {
              mode: "browser",
              code: "123456",
              url: "https://api.vapinetwork.ai/agents",
              expiresAt: 99999,
            },
          }
        : await new Promise((resolve) => {
            poll = resolve;
          }),
    );
    function Harness() {
      const { view, start } = useBackupRelay(purpose);
      return createElement("button", { onClick: () => void start() }, view.kind);
    }
    await render(createElement(Harness));
    await click("idle");
    expect(signer).toHaveBeenCalledWith({ type: "backupStart", purpose });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(signer.mock.calls.filter(([request]) => request.type === "backupPoll")).toHaveLength(1);
    await act(async () =>
      poll({
        ok: true,
        type: "backupPoll",
        result:
          purpose === "enroll" ? { state: "enrolled" } : { state: "approved", owner: "0xabc" },
      }),
    );
    expect(container.textContent).toBe(purpose === "enroll" ? "enrolled" : "approved");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(signer.mock.calls.filter(([request]) => request.type === "backupPoll")).toHaveLength(1);
  },
);

it("shows relay transport failures and allows a new start", async () => {
  const { Backup } = await import("./screens/Backup.js");
  signer.mockRejectedValueOnce(new Error("Signer unavailable."));
  await render(createElement(Backup, { onDone: vi.fn() }));
  await click("Turn on");
  expect(container.textContent).toContain("Signer unavailable.");
  signer.mockResolvedValueOnce({
    ok: true,
    type: "backupStart",
    result: {
      mode: "browser",
      code: "123456",
      url: "https://api.vapinetwork.ai/agents",
      expiresAt: 99999,
    },
  });
  await click("Start again");
  signer.mockRejectedValueOnce(new Error("Polling unavailable."));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(container.textContent).toContain("Polling unavailable.");
  expect(container.textContent).toContain("Start again");
});

it.each([12, 24])(
  "uses the revealed phrase's %i-word length in the Emergency Kit",
  async (count) => {
    const { EmergencyKit } = await import("./screens/EmergencyKit.js");
    signer.mockResolvedValue({
      ok: true,
      type: "revealPhrase",
      words: Array.from({ length: count }, () => "able"),
    });
    await render(
      createElement(EmergencyKit, {
        overview: { owner: null, recovery: null, wallets: [], activity: [], apps: [] },
        onDone: vi.fn(),
      }),
    );
    expect(container.textContent).toContain("The words that bring back your agent wallets");
    await input(container.querySelector("input")!, "password");
    await click("Show the words");
    expect(container.querySelector("header")?.textContent).toContain(`${count} words`);
    expect(container.querySelectorAll("ol li")).toHaveLength(count);
    await click("I wrote them down");
    expect(container.querySelector("header")?.textContent).toContain(`${count} words`);
  },
);

it("explains both supported restore lengths and counts entered words", async () => {
  const { RestoreFromKit } = await import("./screens/Restore.js");
  await render(createElement(RestoreFromKit, { onBack: vi.fn(), onRestored: vi.fn() }));
  expect(container.textContent).toContain("12 or 24 words");
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "able about above",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("3 words");
  expect(container.textContent).not.toContain("of 12");
});
