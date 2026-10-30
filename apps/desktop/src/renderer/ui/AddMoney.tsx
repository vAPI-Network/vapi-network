import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";

import type { OverviewWallet } from "../../shared/overview.js";
import { formatUsd } from "../format.js";
import { Alert, Badge, Button, Waiting } from "./primitives.js";
import { useCopyText } from "../useCopyText.js";
import { Mono } from "./technical.js";

/** Deposit instructions for one wallet. Base only: x402 on Base is gasless for the payer. */
export function AddMoney({ wallet }: { wallet: OverviewWallet }) {
  const [qr, setQr] = useState<string | undefined>();
  const { copy, copied, error: copyError } = useCopyText();
  // The balance when the screen opened; any increase after that is the deposit arriving.
  const startBalance = useRef<string | null | undefined>(undefined);
  if (startBalance.current === undefined) startBalance.current = wallet.balanceAtomic;
  const received =
    wallet.balanceAtomic !== null &&
    startBalance.current !== null &&
    startBalance.current !== undefined
      ? BigInt(wallet.balanceAtomic) - BigInt(startBalance.current)
      : 0n;

  useEffect(() => {
    void QRCode.toString(wallet.address, {
      type: "svg",
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: "#111111", light: "#ffffff" },
    }).then((svg) => setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`));
  }, [wallet.address]);

  return (
    <div className="grid grid-cols-[auto_1fr] gap-8">
      <div className="border-line flex size-[212px] items-center justify-center border bg-white p-4">
        {qr ? (
          <img src={qr} alt={`QR code for ${wallet.address}`} className="size-full" />
        ) : (
          <Waiting />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <span className="text-[18px] leading-6 font-medium">Send USDC on Base</span>
            <Badge tone="base">Base</Badge>
          </div>
          <p className="text-fg-dim max-w-[56ch]">
            Send from an exchange or another wallet to the address below. This wallet does not need
            ETH: x402 payments on Base cost the payer no gas.
          </p>
        </div>
        <div className="flex items-stretch">
          <code className="selectable border-line bg-surface-2 flex min-w-0 flex-1 items-center border border-r-0 px-3 text-[13px] break-all">
            <Mono>{wallet.address}</Mono>
          </code>
          <Button variant="secondary" onClick={() => void copy(wallet.address)} className="w-28">
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {copyError && <Alert tone="error">Could not copy. Try again.</Alert>}
        <Alert tone="warning">
          Only send USDC on the Base network. Transfers on Base are final: vAPI cannot reverse a
          deposit or recover money sent on another network or to a wrong address.
        </Alert>
        {received > 0n ? (
          <Alert tone="success">
            Received {formatUsd(received)}. Balance {formatUsd(wallet.balanceAtomic ?? "0")}.
          </Alert>
        ) : (
          <div className="text-fg-dim flex items-center gap-3 text-[13px]">
            <Waiting />
            <span>
              Watching for your deposit. Balance{" "}
              {wallet.balanceAtomic === null
                ? "unavailable right now"
                : formatUsd(wallet.balanceAtomic)}
              .
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
