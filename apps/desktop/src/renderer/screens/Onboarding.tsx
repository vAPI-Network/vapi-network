import { useState } from "react";

import { isWalletName } from "../../shared/wallet-name.js";
import { NewPasswordFields } from "../ui/NewPasswordFields.js";
import type { WalletSummary } from "../../signer/messages.js";
import { nextStep, STEPS, stepLabels, type Step } from "../onboarding-steps.js";
import { strength } from "../password.js";
import { LimitsFields, PRESETS, useLimitsForm } from "../ui/Limits.js";
import { Alert, Button, Field } from "../ui/primitives.js";
import { Custody } from "./Custody.js";
import { Frame, Title, type FrameStep } from "./Frame.js";

/**
 * First run, four steps (spec §5, amended 2026-10-27). `start` comes from the resume rule.
 * Connecting the vAPI account, connecting an app and adding money are Home cards, not steps.
 */
export function Onboarding({
  start,
  onDone,
  onRestore,
}: {
  start: "welcome" | "protect";
  onRestore: (from: "kit" | "backup") => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<Step>(start);
  const frameStep: FrameStep = { index: STEPS.indexOf(step), labels: stepLabels() };

  function advance() {
    const next = nextStep(step);
    if (next === undefined) onDone();
    else setStep(next);
  }

  if (step === "welcome") {
    return (
      <Frame step={frameStep} actions={<Button onClick={advance}>Get started</Button>}>
        <Title lead="vAPI Desktop keeps your agent's wallet on this Mac. Your agent asks the app to pay for an API, and the app refuses anything over the limits you set.">
          Give your AI a wallet it <span className="font-medium">can't overspend</span>.
        </Title>
        <ul className="bg-line border-line m-0 grid list-none gap-px border p-0">
          {[
            [
              "You hold the keys",
              "Neither Claude nor vAPI ever sees them. Only this app on this Mac can sign a payment.",
            ],
            ["You set the limits", "Per payment and per day. Above that, the payment is blocked."],
            ["Pay with USDC on Base", "No ETH needed. Every payment leaves a receipt."],
          ].map(([title, body]) => (
            <li key={title} className="bg-background flex flex-col gap-0.5 px-4 py-3">
              <span className="font-medium">{title}</span>
              <span className="text-fg-dim text-[13px]">{body}</span>
            </li>
          ))}
        </ul>
        <RestoreLinks onRestore={onRestore} />
      </Frame>
    );
  }

  if (step === "control") return <Custody step={frameStep} onAccepted={advance} />;

  if (step === "protect")
    return <Protect frameStep={frameStep} onDone={advance} onRestore={onRestore} />;

  return <FirstWallet frameStep={frameStep} onDone={advance} onSkip={advance} />;
}

function RestoreLinks({ onRestore }: { onRestore: (from: "kit" | "backup") => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-fg-dim m-0">Moving from another Mac?</p>
      <Button variant="ghost" onClick={() => onRestore("kit")}>
        Restore from Emergency Kit
      </Button>
      <Button variant="ghost" onClick={() => onRestore("backup")}>
        Restore from backup
      </Button>
    </div>
  );
}

function Protect({
  frameStep,
  onDone,
  onRestore,
}: {
  frameStep: FrameStep;
  onDone: () => void;
  onRestore: (from: "kit" | "backup") => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const meter = strength(password);

  async function submit() {
    setBusy(true);
    const result = await window.desktop.signer({ type: "createVault", password });
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.message);
  }

  return (
    <Frame
      step={frameStep}
      actions={
        <Button
          type="submit"
          form="protect-form"
          busy={busy}
          disabled={!meter.ok || confirm !== password}
        >
          Continue
        </Button>
      }
    >
      <Title lead="This password unlocks vAPI Desktop on this Mac. Nobody at vAPI can see it or reset it.">
        Protect vAPI Desktop
      </Title>
      <form
        id="protect-form"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (meter.ok && confirm === password) void submit();
        }}
      >
        <NewPasswordFields
          password={password}
          confirm={confirm}
          onPassword={setPassword}
          onConfirm={setConfirm}
          label="Password"
          hint="No rules about symbols. Length is what counts."
          autoFocus
        />
      </form>
      <Alert tone="warning">
        If you forget this password, vAPI cannot reset it. Your Emergency Kit works even without
        encrypted backup or vAPI. Make it from Home after setup.
      </Alert>
      {error && <Alert tone="error">{error}</Alert>}
      <RestoreLinks onRestore={onRestore} />
    </Frame>
  );
}

function FirstWallet({
  frameStep,
  onDone,
  onSkip,
}: {
  frameStep: FrameStep;
  onDone: (wallet: WalletSummary) => void;
  onSkip: () => void;
}) {
  const [name, setName] = useState("claude");
  const valid = isWalletName(name);
  const form = useLimitsForm({
    initial: PRESETS[0],
    onSave: async (caps) => {
      if (!valid) return "Choose a name first.";
      const result = await window.desktop.signer({ type: "createWallet", name, caps });
      if (!result.ok) return result.message;
      if (result.type === "createWallet") onDone(result.wallet);
      return undefined;
    },
  });
  return (
    <Frame
      step={frameStep}
      actions={
        <>
          <Button onClick={() => void form.save()} busy={form.busy} disabled={!form.canSave}>
            Create agent wallet
          </Button>
          <Button variant="ghost" onClick={onSkip}>
            Later
          </Button>
        </>
      }
    >
      <Title lead="An agent wallet is a separate balance with its own limits. Start with one for Claude.">
        Your first agent wallet
      </Title>
      <Field
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value.toLowerCase())}
        hint="Lowercase letters, numbers and dashes."
        {...(valid ? {} : { error: "Use lowercase letters, numbers and dashes." })}
      />
      <LimitsFields form={form} walletName={valid ? name : "This wallet"} />
    </Frame>
  );
}
