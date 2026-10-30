// apps/desktop/src/renderer/ui/WalletLink.tsx
import { useEffect, useRef } from "react";

import type { WalletLinkState } from "../../signer/messages.js";
import { linkPill } from "../link-flow.js";
import { useLinkFlow } from "../useLinkFlow.js";
import { LinkApproval } from "./LinkApproval.js";
import { Badge, Button } from "./primitives.js";

/**
 * A wallet's link pill with its one-click action (spec §4 home cards). The
 * click links silently on a trusted Mac (D3); otherwise this wallet is approved
 * in the browser right here (D4).
 */
export function WalletLink({
  wallet,
  link,
  startOn,
  onLinked,
}: {
  wallet: string;
  link: WalletLinkState | undefined;
  startOn?: "created" | "clicked";
  onLinked: () => void;
}) {
  const { flow, now, start, openConsole } = useLinkFlow(wallet, onLinked);
  const started = useRef(false);
  useEffect(() => {
    // Revocation blocks creation-driven starts; a fresh click explicitly requests relinking.
    if (!startOn || (startOn === "created" && link === "revoked") || started.current) return;
    started.current = true;
    void start();
  }, [startOn, link, start]);

  if (flow.kind === "linked") return null;

  if (
    flow.kind === "browser" ||
    flow.kind === "declined" ||
    flow.kind === "expired" ||
    flow.kind === "failed"
  ) {
    return (
      <section className="border-line flex flex-col gap-3 border px-5 py-4">
        <h2 className="m-0 text-[16px] leading-6 font-medium">
          {flow.kind === "failed" ? `Link ${wallet}` : `Approve ${wallet} in your browser`}
        </h2>
        <LinkApproval
          flow={flow}
          now={now}
          onStart={() => void start()}
          onOpenConsole={() => void openConsole()}
          startLabel="Link"
        />
      </section>
    );
  }

  const pill = linkPill(link);
  if (pill?.action === undefined) return null;
  return (
    <div className="flex items-center gap-3">
      <Badge tone={pill.tone}>{pill.label}</Badge>
      <Button
        variant="secondary"
        size="compact"
        busy={flow.kind === "starting"}
        onClick={() => void start()}
      >
        {pill.action}
      </Button>
    </div>
  );
}
