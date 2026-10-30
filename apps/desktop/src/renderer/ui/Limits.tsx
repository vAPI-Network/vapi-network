import { useState } from "react";

import { DEFAULT_CAPS } from "../../shared/limits.js";
import { formatUsd, parseUsdToAtomic } from "../format.js";
import { Alert, Button, Field } from "./primitives.js";

export type Caps = { perCallAtomic: string; perDayAtomic: string };

export const PRESETS = [
  { id: "careful", label: "Careful", ...DEFAULT_CAPS },
  { id: "everyday", label: "Everyday", perCallAtomic: "5000000", perDayAtomic: "25000000" },
  { id: "generous", label: "Generous", perCallAtomic: "20000000", perDayAtomic: "100000000" },
] as const;

/** Hard limit in this UI; core has no hard maximum. */
const MAX_DAY_ATOMIC = 1_000_000_000n;

function dollars(atomic: string): string {
  return formatUsd(atomic).slice(1);
}

export function validateCaps(perCall: string, perDay: string): Caps | string {
  const perCallAtomic = parseUsdToAtomic(perCall);
  const perDayAtomic = parseUsdToAtomic(perDay);
  if (perCallAtomic === undefined || perDayAtomic === undefined)
    return "Enter dollar amounts, like 1 or 0.50.";
  if (BigInt(perCallAtomic) === 0n || BigInt(perDayAtomic) === 0n)
    return "A limit of $0 blocks every payment.";
  if (BigInt(perCallAtomic) > BigInt(perDayAtomic))
    return "Per payment cannot be more than per day.";
  if (BigInt(perDayAtomic) > MAX_DAY_ATOMIC) return "Per day is limited to $1,000 in this version.";
  return { perCallAtomic, perDayAtomic };
}

export function isRaise(next: Caps, current: Caps): boolean {
  return (
    BigInt(next.perCallAtomic) > BigInt(current.perCallAtomic) ||
    BigInt(next.perDayAtomic) > BigInt(current.perDayAtomic)
  );
}

export function limitsState(input: {
  perCall: string;
  perDay: string;
  current?: Caps;
  password: string;
}) {
  const parsed = validateCaps(input.perCall, input.perDay);
  const caps = typeof parsed === "string" ? undefined : parsed;
  const raising = caps !== undefined && input.current !== undefined && isRaise(caps, input.current);
  const unchanged =
    caps !== undefined &&
    input.current !== undefined &&
    caps.perCallAtomic === input.current.perCallAtomic &&
    caps.perDayAtomic === input.current.perDayAtomic;
  const preset = PRESETS.find(
    (entry) =>
      caps?.perCallAtomic === entry.perCallAtomic && caps.perDayAtomic === entry.perDayAtomic,
  );
  const canSave = caps !== undefined && !unchanged && !(raising && input.password.length === 0);
  return { parsed, caps, raising, unchanged, preset, canSave };
}

export type LimitsForm = ReturnType<typeof limitsState> & {
  perCall: string;
  perDay: string;
  password: string;
  error: string | undefined;
  saved: boolean;
  busy: boolean;
  setPerCall: (value: string) => void;
  setPerDay: (value: string) => void;
  setPassword: (value: string) => void;
  applyPreset: (entry: (typeof PRESETS)[number]) => void;
  save: () => Promise<void>;
};

/** State for the limits form; the caller decides where the save button lives. */
export function useLimitsForm({
  initial,
  current,
  onSave,
}: {
  initial: Caps;
  current?: Caps;
  onSave: (caps: Caps, password?: string) => Promise<string | undefined>;
}): LimitsForm {
  const [perCall, setPerCallRaw] = useState(dollars(initial.perCallAtomic));
  const [perDay, setPerDayRaw] = useState(dollars(initial.perDayAtomic));
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = limitsState({
    perCall,
    perDay,
    ...(current === undefined ? {} : { current }),
    password,
  });

  function setPerCall(value: string) {
    setPerCallRaw(value);
    setSaved(false);
  }
  function setPerDay(value: string) {
    setPerDayRaw(value);
    setSaved(false);
  }
  function applyPreset(entry: (typeof PRESETS)[number]) {
    setPerCallRaw(dollars(entry.perCallAtomic));
    setPerDayRaw(dollars(entry.perDayAtomic));
    setSaved(false);
  }
  async function save() {
    if (state.caps === undefined) return;
    setBusy(true);
    setSaved(false);
    const message = await onSave(state.caps, state.raising ? password : undefined);
    setBusy(false);
    setError(message);
    if (message === undefined) {
      setSaved(true);
      setPassword("");
    }
  }

  return {
    ...state,
    perCall,
    perDay,
    password,
    error,
    saved,
    busy,
    setPerCall,
    setPerDay,
    setPassword,
    applyPreset,
    save,
  };
}

/** Presets, amounts, the consequence sentence, and the password field when raising. No button. */
export function LimitsFields({
  form,
  walletName,
  current,
}: {
  form: LimitsForm;
  walletName: string;
  current?: Caps;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="bg-line border-line grid grid-cols-3 gap-px border">
        {PRESETS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => form.applyPreset(entry)}
            className={`hover:bg-hover-surface flex flex-col items-start gap-1 px-4 py-3 text-left transition-colors ${
              form.preset?.id === entry.id
                ? "bg-surface-2 text-foreground"
                : "bg-background text-fg-dim"
            }`}
            aria-pressed={form.preset?.id === entry.id}
          >
            <span className="text-foreground text-[14px] font-medium">{entry.label}</span>
            <span className="text-[13px] leading-5 tabular-nums">
              {formatUsd(entry.perCallAtomic)} a payment
              <br />
              {formatUsd(entry.perDayAtomic)} a day
            </span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Field
          label="Per payment ($)"
          inputMode="decimal"
          value={form.perCall}
          onChange={(event) => form.setPerCall(event.target.value)}
        />
        <Field
          label="Per day ($)"
          inputMode="decimal"
          value={form.perDay}
          onChange={(event) => form.setPerDay(event.target.value)}
        />
      </div>
      {typeof form.parsed === "string" ? (
        <p className="text-pink-text text-[13px]">{form.parsed}</p>
      ) : (
        <p className="text-fg-dim max-w-[60ch]">
          {walletName} can pay at most {formatUsd(form.parsed.perCallAtomic)} for one API call and{" "}
          {formatUsd(form.parsed.perDayAtomic)} in total per day (UTC). This app blocks anything
          above that, even if the agent asks. Payments within these limits are final.
        </p>
      )}
      {form.raising && (
        <Field
          label="Your password"
          type="password"
          value={form.password}
          hint="Raising a limit needs your password, so an agent cannot do it for you."
          onChange={(event) => form.setPassword(event.target.value)}
        />
      )}
      {form.error && <Alert tone="error">{form.error}</Alert>}
      {form.saved && current !== undefined && <Alert tone="success">Limits saved.</Alert>}
    </div>
  );
}

type Props = {
  walletName: string;
  initial: Caps;
  /** Present when editing an existing wallet: raising a limit then asks for the password. */
  current?: Caps;
  saveLabel: string;
  onSave: (caps: Caps, password?: string) => Promise<string | undefined>;
};

/** Fields plus the save row, for places that keep the button under the form (wallet Limits tab). */
export function LimitsEditor({ walletName, initial, current, saveLabel, onSave }: Props) {
  const form = useLimitsForm({ initial, ...(current === undefined ? {} : { current }), onSave });
  return (
    <div className="flex flex-col gap-5">
      <LimitsFields
        form={form}
        walletName={walletName}
        {...(current === undefined ? {} : { current })}
      />
      <div className="flex items-center gap-3">
        <Button onClick={() => void form.save()} busy={form.busy} disabled={!form.canSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
