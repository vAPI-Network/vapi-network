// apps/desktop/src/renderer/ui/LinkApproval.tsx
import {
  declinedMessage,
  EXPIRED_MESSAGE,
  formatCountdown,
  OPEN_FAILED_MESSAGE,
  OPEN_FAILED_WITHOUT_PAGE_MESSAGE,
  type LinkFlow,
} from "../link-flow.js";
import { Alert, Button, Waiting } from "./primitives.js";
import { Mono } from "./technical.js";

/** The browser half of a link: the code, the console button, the countdown, and how it ended. */
export function LinkApproval({
  flow,
  now,
  onStart,
  onOpenConsole,
  onSkip,
  startLabel = "Open the console",
}: {
  flow: LinkFlow;
  now: number;
  onStart: () => void;
  onOpenConsole: () => void;
  onSkip?: () => void;
  startLabel?: string;
}) {
  if (flow.kind === "linked") return null;

  if (flow.kind === "browser") {
    return (
      <div className="flex flex-col gap-4">
        <div className="border-line flex items-center justify-between gap-4 border px-4 py-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-fg-dim text-[12px]">The console shows this code</span>
            <Mono className="text-[22px] leading-7 tracking-[0.08em]">{flow.userCode}</Mono>
          </span>
          <span className="text-fg-dim text-[13px] tabular-nums">
            {formatCountdown(flow.expiresAt - now)}
          </span>
        </div>
        <p className="text-fg-dim m-0 text-[13px]">
          Tick &ldquo;Trust this device for new accounts&rdquo; in the console. The next agent
          wallets on this Mac then link without another approval.
        </p>
        {flow.openFailedPage !== undefined && (
          <Alert tone="error">
            {flow.openFailedPage === null ? (
              OPEN_FAILED_WITHOUT_PAGE_MESSAGE
            ) : (
              <>
                {OPEN_FAILED_MESSAGE}{" "}
                <Mono className="break-all select-text">{flow.openFailedPage}</Mono>
              </>
            )}
          </Alert>
        )}
        <div className="flex items-center gap-4">
          <Button variant="secondary" onClick={onOpenConsole}>
            Open the console again
          </Button>
          <span className="text-fg-dim text-[13px]">
            <Waiting label="Waiting for your approval" />
          </span>
        </div>
        {onSkip && (
          <div>
            <Button variant="ghost" onClick={onSkip}>
              Connect later
            </Button>
          </div>
        )}
      </div>
    );
  }

  const message =
    flow.kind === "declined"
      ? declinedMessage(onSkip !== undefined)
      : flow.kind === "expired"
        ? EXPIRED_MESSAGE
        : flow.kind === "failed"
          ? flow.message
          : undefined;
  return (
    <div className="flex flex-col gap-4">
      {message && <Alert tone={flow.kind === "failed" ? "error" : "warning"}>{message}</Alert>}
      <div className="flex gap-3">
        <Button busy={flow.kind === "starting"} onClick={onStart}>
          {flow.kind === "expired"
            ? "Get a new code"
            : flow.kind === "idle" || flow.kind === "starting"
              ? startLabel
              : "Try again"}
        </Button>
        {onSkip && (
          <Button variant="ghost" onClick={onSkip}>
            {flow.kind === "failed" ? "Connect later" : "Skip"}
          </Button>
        )}
      </div>
    </div>
  );
}
