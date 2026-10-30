import type { ReactNode } from "react";

export function PageHeader({ title, lead }: { title: ReactNode; lead?: string }) {
  return (
    <header className="flex flex-col gap-2">
      <h1 className="m-0 text-[28px] leading-[34px] font-normal tracking-[-0.02em]">{title}</h1>
      {lead && <p className="text-fg-dim m-0 max-w-[64ch]">{lead}</p>}
    </header>
  );
}
