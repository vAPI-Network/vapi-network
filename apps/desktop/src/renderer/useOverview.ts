import { useEffect, useMemo, useState } from "react";
import type { Overview } from "../shared/overview.js";
import { singleFlight } from "./single-flight.js";

/** Polls main for balances, activity and app state. Faster while the user waits for a deposit. */
export function useOverview(intervalMs: number, initial?: Overview) {
  const [overview, setOverview] = useState<Overview | undefined>(initial);
  const [error, setError] = useState<string | undefined>();
  const refresh = useMemo(
    () =>
      singleFlight(async () => {
        try {
          const result = await window.desktop.overview();
          if (result.ok) {
            const { ok: _ok, ...rest } = result;
            setOverview(rest);
            setError(undefined);
          } else {
            setError(result.message);
          }
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        }
      }),
    [],
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, refresh]);

  return { overview, error, refresh };
}
