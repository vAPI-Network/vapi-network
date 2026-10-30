// apps/desktop/src/renderer/password.ts

/** Protect and restore share one rule: length counts, no composition rules (spec §5). */
export function strength(password: string): { label: string; ok: boolean } {
  if (password.length < 8) return { label: "Use at least 8 characters.", ok: false };
  if (password.length < 12) return { label: "Okay. A longer password is stronger.", ok: true };
  return { label: "Strong.", ok: true };
}
