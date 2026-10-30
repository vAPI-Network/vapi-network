import type { ReactNode } from "react";

export function SetupCard({
  title,
  badge,
  body,
  action,
}: {
  title: string;
  badge?: ReactNode;
  body: ReactNode;
  action: ReactNode;
}) {
  const heading = <span className="text-[18px] leading-6 font-medium">{title}</span>;
  return (
    <section className="border-line bg-surface-2 flex flex-col items-start gap-3 border px-6 py-6">
      {badge ? (
        <div className="flex flex-wrap items-center gap-3">
          {heading}
          {badge}
        </div>
      ) : (
        heading
      )}
      <span className="text-fg-dim max-w-[52ch]">{body}</span>
      {action}
    </section>
  );
}
