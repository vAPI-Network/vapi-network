import { useCallback, useEffect, useRef, useState } from "react";

import type { BackupPurpose } from "../signer/messages.js";
import { relayView, type RelayView } from "./relay-flow.js";

export function useBackupRelay(purpose: BackupPurpose) {
  const [view, setView] = useState<RelayView>({ kind: "idle" });
  const requestId = useRef(0);

  useEffect(
    () => () => {
      requestId.current += 1;
    },
    [purpose],
  );

  const fail = useCallback((message: string) => {
    requestId.current += 1;
    setView({ kind: "error", message });
  }, []);

  const start = useCallback(async () => {
    const id = ++requestId.current;
    setView({ kind: "starting" });
    try {
      const response = await window.desktop.signer({ type: "backupStart", purpose });
      if (id !== requestId.current) return;
      if (!response.ok) return fail(response.message);
      if (response.type !== "backupStart") return fail("Unexpected reply.");
      const next = relayView(response.result);
      setView(next);
      if (next.kind === "code") await window.desktop.openConsole(next.url);
    } catch (error) {
      if (id === requestId.current) fail(error instanceof Error ? error.message : String(error));
    }
  }, [purpose, fail]);

  useEffect(() => {
    if (view.kind !== "code") return;
    let active = true;
    let polling = false;
    const id = requestId.current;
    const timer = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await window.desktop.signer({ type: "backupPoll" });
        if (!active || id !== requestId.current) return;
        if (!response.ok) return fail(response.message);
        if (response.type !== "backupPoll") return fail("Unexpected reply.");
        const next = relayView(response.result);
        if (next.kind !== "idle") setView(next);
      } catch (error) {
        if (active && id === requestId.current)
          fail(error instanceof Error ? error.message : String(error));
      } finally {
        polling = false;
      }
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [view.kind, fail]);

  return { view, start, fail };
}
