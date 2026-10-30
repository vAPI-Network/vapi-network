import { useCallback, useEffect, useRef, useState } from "react";

export function useCopyText() {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<number | undefined>(undefined);
  const requestId = useRef(0);

  useEffect(
    () => () => {
      requestId.current += 1;
      window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(async (text: string) => {
    const id = ++requestId.current;
    window.clearTimeout(timer.current);
    setState("idle");
    try {
      await window.desktop.copyText(text);
      if (id === requestId.current) setState("copied");
    } catch {
      if (id === requestId.current) setState("error");
    } finally {
      if (id === requestId.current) timer.current = window.setTimeout(() => setState("idle"), 2000);
    }
  }, []);

  return { copy, copied: state === "copied", error: state === "error" };
}
