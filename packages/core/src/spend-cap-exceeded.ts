export type SpendCapKind = "per_call" | "per_day" | "max_price" | "max_amount" | "run_budget";

export type SpendCapExceededInput = {
  cap: SpendCapKind;
  amountUsd: string;
  limitUsd: string;
  spentUsd?: string;
  perDayLimitUsd?: string;
  wallet?: string;
  cause?: unknown;
  message?: string;
  command?: string | null;
};

/** Stable, user-actionable error returned when a payment is stopped before signing. */
export class SpendCapExceededError extends Error {
  readonly name = "SpendCapExceededError";
  readonly code = "spend_cap_exceeded";
  readonly retryable = false;
  readonly cap: SpendCapKind;
  readonly amountUsd: string;
  readonly limitUsd: string;
  readonly spentUsd?: string;
  readonly wallet?: string;
  readonly command: string | null;

  constructor(input: SpendCapExceededInput) {
    const amountUsd = normalizeUsd(input.amountUsd);
    const limitUsd = normalizeUsd(input.limitUsd);
    const spentUsd = input.spentUsd === undefined ? undefined : normalizeUsd(input.spentUsd);
    const wallet = input.wallet?.trim() || undefined;
    const command =
      input.command === undefined
        ? spendCapCommand(input.cap, amountUsd, spentUsd, wallet, input.perDayLimitUsd)
        : input.command;
    super(
      input.message ?? spendCapMessage(input.cap, amountUsd, limitUsd, spentUsd, wallet, command),
      input.cause === undefined ? undefined : { cause: input.cause },
    );
    this.cap = input.cap;
    this.amountUsd = amountUsd;
    this.limitUsd = limitUsd;
    this.spentUsd = spentUsd;
    this.wallet = wallet;
    this.command = command;
  }

  toJSON(): {
    code: "spend_cap_exceeded";
    cap: SpendCapKind;
    amountUsd: string;
    limitUsd: string;
    spentUsd?: string;
    wallet?: string;
    command: string | null;
    message: string;
  } {
    return {
      code: this.code,
      cap: this.cap,
      amountUsd: this.amountUsd,
      limitUsd: this.limitUsd,
      ...(this.spentUsd === undefined ? {} : { spentUsd: this.spentUsd }),
      ...(this.wallet === undefined ? {} : { wallet: this.wallet }),
      command: this.command,
      message: this.message,
    };
  }
}

function spendCapCommand(
  cap: SpendCapKind,
  amountUsd: string,
  spentUsd: string | undefined,
  wallet: string | undefined,
  perDayLimitUsd: string | undefined,
): string | null {
  const account = wallet ?? "<account>";
  if (cap === "per_call") {
    const scale = Math.max(fractionLength(amountUsd), fractionLength(perDayLimitUsd ?? "0"));
    const raiseDay =
      perDayLimitUsd !== undefined &&
      parseDecimal(amountUsd, scale) > parseDecimal(perDayLimitUsd, scale);
    return `vapi accounts caps ${account} --per-call ${amountUsd}${raiseDay ? ` --per-day ${amountUsd}` : ""}`;
  }
  if (cap === "per_day") {
    return `vapi accounts caps ${account} --per-day ${addUsd(spentUsd ?? "0", amountUsd)}`;
  }
  if (cap === "max_price") {
    return `--max ${amountUsd}`;
  }
  if (cap === "run_budget") {
    const budget = addUsd(spentUsd ?? "0", amountUsd);
    return `--budget ${budget}`;
  }
  return null;
}

function spendCapMessage(
  cap: SpendCapKind,
  amountUsd: string,
  limitUsd: string,
  spentUsd: string | undefined,
  wallet: string | undefined,
  command: string | null,
): string {
  const capName =
    cap === "per_call"
      ? "per-call spend cap"
      : cap === "per_day"
        ? "per-day spend cap"
        : cap === "max_price"
          ? "maximum price"
          : cap === "max_amount"
            ? "maximum amount"
            : "run budget";
  const account =
    cap === "per_call" || cap === "per_day" ? ` of account ${wallet ?? "<account>"}` : "";
  const payment =
    cap === "per_day" || cap === "run_budget"
      ? `this payment of $${amountUsd} would raise ${cap === "per_day" ? "today's spend" : "run spend"} from $${spentUsd ?? "0"} to $${addUsd(spentUsd ?? "0", amountUsd)}, above $${limitUsd}`
      : `this payment of $${amountUsd} exceeds the limit of $${limitUsd}`;
  const guidance =
    cap === "max_price"
      ? ` MCP call.pay takes maxPriceUsd. Raise the CLI maximum with:`
      : cap === "run_budget"
        ? " Raise it on vapi agent run or vapi swarm run with:"
        : " Raise it with:";
  const action = command === null ? "" : `${guidance} ${command}`;
  return `Blocked by the ${capName}${account}: ${payment}. Nothing was signed.${action}`;
}

function normalizeUsd(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes(".")) return trimmed;
  const normalized = trimmed.replace(/0+$/u, "").replace(/\.$/u, "");
  return normalized || "0";
}

function addUsd(left: string, right: string): string {
  const scale = Math.max(fractionLength(left), fractionLength(right));
  const factor = 10n ** BigInt(scale);
  const total = parseDecimal(left, scale) + parseDecimal(right, scale);
  const whole = total / factor;
  const fraction = (total % factor).toString().padStart(scale, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function fractionLength(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

function parseDecimal(value: string, scale: number): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0") || "0");
}
