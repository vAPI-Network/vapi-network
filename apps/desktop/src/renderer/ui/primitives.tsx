import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "secondary" | "ghost" | "destructive";
  size?: "md" | "compact" | "touch";
  busy?: boolean;
};

/** The shared `.vapi-btn` contract from `./design-tokens/utilities.css` (vendored from vapi-app). */
export function Button({
  variant = "default",
  size = "md",
  busy = false,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={`vapi-btn vapi-btn--${variant} vapi-btn--${size} ${className}`}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Waiting label="Waiting" /> : children}
    </button>
  );
}

/** Three static-shape squares; the design system never uses spinners. */
export function Waiting({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="vapi-waiting inline-flex gap-1" aria-hidden>
        <span className="size-1.5 bg-current" />
        <span className="size-1.5 bg-current" />
        <span className="size-1.5 bg-current" />
      </span>
      {label && <span>{label}</span>}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      <input
        className="vapi-control-ladder h-9 px-3 text-[14px] outline-none"
        aria-invalid={error ? true : undefined}
        {...input}
      />
      {error ? (
        <span className="text-pink-text text-[12px] leading-4">{error}</span>
      ) : hint ? (
        <span className="text-fg-dim text-[12px] leading-4">{hint}</span>
      ) : null}
    </label>
  );
}

type Tone = "neutral" | "live" | "blocked" | "error" | "base";
const TONES: Record<Tone, { marker: string; text: string }> = {
  neutral: { marker: "bg-fg-dimmer", text: "text-fg-dim" },
  live: { marker: "bg-lime", text: "text-lime-text" },
  blocked: { marker: "bg-orange", text: "text-orange-text" },
  error: { marker: "bg-pink", text: "text-pink-text" },
  base: { marker: "bg-blue", text: "text-blue-text" },
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  const recipe = TONES[tone];
  return (
    <span
      className={`border-line inline-flex h-6 shrink-0 items-center gap-2 border px-2 text-[12px] font-medium whitespace-nowrap ${recipe.text}`}
    >
      <span className={`size-2 ${recipe.marker}`} aria-hidden />
      {children}
    </span>
  );
}

export function Alert({
  tone,
  children,
}: {
  tone: "info" | "success" | "warning" | "error";
  children: ReactNode;
}) {
  const marker = { info: "bg-cyan", success: "bg-lime", warning: "bg-orange", error: "bg-pink" }[
    tone
  ];
  const text = tone === "error" ? "text-pink-text" : tone === "warning" ? "text-orange-text" : "";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="border-line bg-background flex min-h-11 items-start gap-3 border px-3 py-2.5"
    >
      <span className={`mt-1.5 size-2 shrink-0 ${marker}`} aria-hidden />
      <div className={`text-[14px] leading-5 ${text}`}>{children}</div>
    </div>
  );
}

/** Wallet identity: a square monogram. Colour stays semantic, so wallets are told apart by letter. */
export function Monogram({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="bg-foreground text-background inline-flex shrink-0 items-center justify-center font-medium"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Spent against a limit. Orange marks the limit being reached; it is never the fill colour otherwise. */
export function SpendBar({ spent, limit }: { spent: bigint; limit: bigint }) {
  const ratio = limit === 0n ? 1 : Math.min(1, Number((spent * 1000n) / limit) / 1000);
  return (
    <div className="bg-surface-3 h-1.5 w-full" aria-hidden>
      <div
        className={`h-full ${ratio >= 1 ? "bg-orange" : "bg-foreground"}`}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="border-line flex gap-6 border-b">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          onClick={() => onChange(tab.id)}
          className={`-mb-px h-10 border-b-2 text-[14px] font-medium transition-colors ${
            tab.id === value
              ? "border-orange text-foreground"
              : "text-fg-dim hover:text-foreground border-transparent"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="bg-background flex flex-col gap-2 px-6 py-5">
      <span className="text-fg-dim text-[13px] font-medium">{label}</span>
      <span className="text-[24px] leading-7 font-medium tracking-[-0.02em] tabular-nums">
        {value}
      </span>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-line bg-surface-2 flex flex-col items-start gap-2 border px-6 py-8">
      <span className="text-[18px] leading-6 font-medium">{title}</span>
      <span className="text-fg-dim max-w-[52ch]">{children}</span>
    </div>
  );
}
