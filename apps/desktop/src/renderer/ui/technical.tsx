import type { ReactNode } from "react";

/**
 * Machine strings (wallet addresses, device codes) in the mono face. The public
 * copy check allows `font-mono` in this file only, so mono never spreads to copy.
 */
export function Mono({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={className ? `font-mono ${className}` : "font-mono"}>{children}</span>;
}
