import type { ActivityItem } from "../../shared/overview.js";
import { formatUsd } from "../format.js";
import { Badge, EmptyState } from "./primitives.js";

const OUTCOME = {
  paid: { tone: "live", label: "Paid" },
  blocked: { tone: "blocked", label: "Blocked" },
  failed: { tone: "error", label: "Failed" },
  unknown: { tone: "neutral", label: "Unconfirmed" },
} as const;

function time(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function ActivityList({
  items,
  showWallet,
}: {
  items: ActivityItem[];
  showWallet: boolean;
}) {
  if (items.length === 0) {
    return (
      <EmptyState title="No payments yet">
        When your agent pays for an API, the receipt appears here with the amount and the Base
        transaction.
      </EmptyState>
    );
  }
  return (
    <div className="border-line border">
      {items.map((item) => {
        const outcome = OUTCOME[item.outcome];
        return (
          <div
            key={item.id}
            className="border-line flex h-11 items-center gap-4 border-b px-4 last:border-b-0"
          >
            <span className="text-fg-dim w-14 shrink-0 text-[13px] tabular-nums">
              {time(item.timestamp)}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {item.host}
              {showWallet && <span className="text-fg-dim"> · {item.wallet}</span>}
            </span>
            <span className="w-20 shrink-0 text-right tabular-nums">
              {item.amountAtomic === null ? "" : formatUsd(item.amountAtomic)}
            </span>
            <span className="w-28 shrink-0">
              <Badge tone={outcome.tone}>{outcome.label}</Badge>
            </span>
            <span className="w-20 shrink-0 text-right">
              {item.explorerUrl?.startsWith("https://basescan.org/") && (
                <button
                  type="button"
                  className="text-link text-[13px] underline-offset-4 hover:underline"
                  onClick={() => void window.desktop.openExplorer(item.explorerUrl ?? "")}
                >
                  Basescan
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
