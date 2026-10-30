import { useEffect, useState } from "react";

import type { Overview } from "../shared/overview.js";
import { resumeScreen } from "./resume.js";
import { Custody } from "./screens/Custody.js";
import { Onboarding } from "./screens/Onboarding.js";
import { RestoreFromBackup, RestoreFromKit } from "./screens/Restore.js";
import { Shell } from "./screens/Shell.js";
import { Unlock } from "./screens/Unlock.js";
import { BootLoader } from "./ui/Logo.js";

type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "onboarding"; start: "welcome" | "protect" }
  | { kind: "restore"; from: "kit" | "backup" }
  | { kind: "unlock" }
  | { kind: "custody" }
  | { kind: "main"; initial?: Overview };

/** Long enough for the mark to assemble once, so the loader never flickers. */
const MIN_BOOT_MS = 1100;

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  // The loader covers the unlock → home handoff while the first balances load.
  const [boot, setBoot] = useState<"off" | "on" | "fading">("off");

  async function bootIntoMain() {
    setBoot("on");
    try {
      const [result] = await Promise.all([
        window.desktop.overview(),
        new Promise((resolve) => window.setTimeout(resolve, MIN_BOOT_MS)),
      ]);
      if (result.ok) {
        const { ok: _ok, ...initial } = result;
        setScreen({ kind: "main", initial });
      } else {
        setScreen({ kind: "main" });
      }
    } catch {
      setScreen({ kind: "main" });
    } finally {
      setBoot("fading");
      window.setTimeout(() => setBoot("off"), 300);
    }
  }

  async function route() {
    const status = await window.desktop.signer({ type: "status" });
    if (!status.ok || status.type !== "status") {
      return setScreen({
        kind: "error",
        message: "vAPI Desktop could not reach its signer. Quit and reopen the app.",
      });
    }
    const next = resumeScreen({
      vault: status.vault,
      custodyAccepted: await window.desktop.custodyAccepted(),
    });
    switch (next) {
      case "welcome":
      case "protect":
        return setScreen({ kind: "onboarding", start: next });
      case "unlock":
        return setScreen({ kind: "unlock" });
      case "custody":
        return setScreen({ kind: "custody" });
      case "home":
        return await bootIntoMain();
    }
  }

  useEffect(() => {
    void route();
  }, []);

  return (
    <>
      {renderScreen()}
      {boot !== "off" && <BootLoader done={boot === "fading"} label="Opening your agent wallets" />}
    </>
  );

  function renderScreen() {
    switch (screen.kind) {
      case "loading":
        return <div className="bg-app-canvas h-full" />;
      case "error":
        return (
          <div className="bg-app-canvas flex h-full items-center justify-center p-8">
            <p className="text-pink-text max-w-[48ch]">{screen.message}</p>
          </div>
        );
      case "onboarding":
        return (
          <Onboarding
            start={screen.start}
            onDone={() => void bootIntoMain()}
            onRestore={(from) => setScreen({ kind: "restore", from })}
          />
        );
      case "restore":
        return screen.from === "kit" ? (
          <RestoreFromKit onBack={() => void route()} onRestored={() => void route()} />
        ) : (
          <RestoreFromBackup onBack={() => void route()} onRestored={() => void route()} />
        );
      case "custody":
        return <Custody onAccepted={() => void bootIntoMain()} />;
      case "unlock":
        return <Unlock onUnlocked={() => void route()} />;
      case "main":
        return (
          <Shell
            onLocked={() => setScreen({ kind: "unlock" })}
            {...(screen.initial === undefined ? {} : { initial: screen.initial })}
          />
        );
    }
  }
}
