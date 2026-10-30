// apps/desktop/src/renderer/useLinkFlow.ts
import { useCallback, useEffect, useRef, useState } from "react";

import {
  afterOpened,
  afterOpenFailed,
  afterPoll,
  afterStart,
  afterTick,
  type LinkFlow,
} from "./link-flow.js";

const POLL_MS = 2000;

/**
 * Runs one wallet's link: start it in the signer, open the console when the
 * browser must approve, poll until it ends. The renderer never sees a token.
 */
export function useLinkFlow(wallet: string | undefined, onLinked?: () => void) {
  const [flow, setFlow] = useState<LinkFlow>({ kind: "idle" });
  const [now, setNow] = useState(() => Date.now());
  const linked = useRef(onLinked);
  linked.current = onLinked;
  const requestId = useRef(0);

  useEffect(() => {
    return () => {
      requestId.current += 1;
    };
  }, [wallet]);

  const openBrowser = useCallback(async (url: string, id: number) => {
    try {
      const result = await window.desktop.openConsole(url);
      setFlow((current) =>
        id === requestId.current
          ? result.opened
            ? afterOpened(current)
            : afterOpenFailed(current, result.page)
          : current,
      );
    } catch {
      setFlow((current) => (id === requestId.current ? afterOpenFailed(current) : current));
    }
  }, []);

  const openConsole = useCallback(async () => {
    if (flow.kind === "browser") await openBrowser(flow.url, requestId.current);
  }, [flow, openBrowser]);

  const start = useCallback(async () => {
    const id = ++requestId.current;
    if (wallet === undefined) return;
    setFlow({ kind: "starting" });
    try {
      const response = await window.desktop.signer({ type: "linkStart", wallet });
      if (id !== requestId.current) return;
      if (!response.ok) return setFlow({ kind: "failed", message: response.message });
      if (response.type !== "linkStart") {
        return setFlow({ kind: "failed", message: "Unexpected reply." });
      }
      setNow(Date.now());
      setFlow(afterStart(response.result));
      // Open browser approval for a manual start or the inline link after wallet creation.
      if (response.result.mode === "browser") await openBrowser(response.result.url, id);
    } catch {
      if (id !== requestId.current) return;
      setFlow({ kind: "failed", message: "vAPI Desktop could not start the link. Try again." });
    }
  }, [wallet, openBrowser]);

  useEffect(() => {
    if (flow.kind !== "browser" || wallet === undefined) return;
    const poller = window.setInterval(async () => {
      const response = await window.desktop.signer({ type: "linkPoll", wallet });
      const time = Date.now();
      if (response.ok && response.type === "linkPoll") {
        setFlow((current) => afterPoll(current, response.result, time));
      }
    }, POLL_MS);
    const clock = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      setFlow((current) => afterTick(current, time));
    }, 1000);
    return () => {
      window.clearInterval(poller);
      window.clearInterval(clock);
    };
  }, [flow.kind, wallet]);

  useEffect(() => {
    if (flow.kind === "linked") linked.current?.();
  }, [flow.kind]);

  return { flow, now, start, openConsole };
}
