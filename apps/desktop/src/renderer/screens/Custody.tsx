import { useState } from "react";

import { CUSTODY_TERMS } from "../../shared/custody.js";
import { Alert, Button } from "../ui/primitives.js";
import { Frame, Title, type FrameStep } from "./Frame.js";

const FACTS = [
  [
    "You hold the keys",
    "Your wallet keys are encrypted with your password and stored only on this Mac. vAPI never receives them.",
  ],
  [
    "Only you can move the money",
    "This app signs every payment on this Mac. vAPI cannot freeze, move, or recover your funds.",
  ],
  ["Payments are final", "A payment on Base is final. Neither you nor vAPI can reverse it."],
  [
    "Your limits are the safety net",
    "Your agents can spend only up to the limits you set. Keep balances to what you are willing to let them spend.",
  ],
] as const;

/** The custody screen: what non-custodial means here and what the user is responsible for. */
export function Custody({ step, onAccepted }: { step?: FrameStep; onAccepted: () => void }) {
  const [checked, setChecked] = useState<boolean[]>(CUSTODY_TERMS.statements.map(() => false));
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    try {
      await window.desktop.acceptCustody(CUSTODY_TERMS.version);
      onAccepted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Frame
      {...(step === undefined ? {} : { step })}
      actions={
        <Button busy={busy} disabled={!checked.every(Boolean)} onClick={() => void accept()}>
          I understand
        </Button>
      }
    >
      <Title lead="vAPI Desktop is non-custodial. That gives you full control, and it also makes you responsible for these wallets.">
        You are in control
      </Title>
      <ul className="bg-line border-line m-0 grid list-none grid-cols-2 gap-px border p-0">
        {FACTS.map(([title, body]) => (
          <li key={title} className="bg-background flex flex-col gap-1 px-4 py-3">
            <span className="font-medium">{title}</span>
            <span className="text-fg-dim text-[13px] leading-5">{body}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-3">
        {CUSTODY_TERMS.statements.map((statement, index) => (
          <label key={statement} className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="accent-foreground mt-0.5 size-4 shrink-0"
              checked={checked[index] ?? false}
              onChange={(event) =>
                setChecked((current) =>
                  current.map((value, at) => (at === index ? event.target.checked : value)),
                )
              }
            />
            <span className="text-[14px] leading-5">{statement}</span>
          </label>
        ))}
      </div>
      {error && <Alert tone="error">{error}</Alert>}
    </Frame>
  );
}
