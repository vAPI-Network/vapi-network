import type { ReactNode } from "react";

import { stepStatus } from "../onboarding-steps.js";
import { DesktopBrand } from "../ui/Logo.js";

export type FrameStep = { index: number; labels: readonly string[] };

/**
 * The first-run and unlock layout on the window itself: the step list sits on the left where the
 * sidebar sits later, the content is one left-aligned column with the same top edge on every
 * step, and the buttons stay in a row at the bottom. No box, no border, no shadow.
 */
export function Frame({
  step,
  actions,
  children,
}: {
  step?: FrameStep;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bg-app-canvas grid h-full grid-cols-[280px_1fr]">
      <aside className="flex min-h-0 flex-col">
        <div className="app-drag h-[52px] shrink-0" aria-hidden />
        <div className="px-[18px] pb-8">
          <DesktopBrand />
        </div>
        {step && (
          <ol className="m-0 flex list-none flex-col gap-3 p-0 px-[18px]" aria-label="Setup steps">
            {step.labels.map((label, index) => {
              const status = stepStatus(index, step.index);
              return (
                <li
                  key={label}
                  className={`flex items-center gap-3 text-[14px] leading-5 ${
                    status === "current" ? "text-foreground" : "text-fg-dim"
                  }`}
                  aria-current={status === "current" ? "step" : undefined}
                >
                  <span
                    className={`h-1 w-5 shrink-0 ${status === "todo" ? "bg-line-2" : "bg-foreground"}`}
                    aria-hidden
                  />
                  {label}
                </li>
              );
            })}
          </ol>
        )}
      </aside>
      <div className="flex min-h-0 flex-col">
        <div className="app-drag h-[52px] shrink-0" aria-hidden />
        <div className="min-h-0 flex-1 overflow-y-auto px-10">
          <div className="flex w-full max-w-[480px] flex-col gap-6 pb-6">{children}</div>
        </div>
        {actions && (
          <div className="shrink-0 px-10 pt-4 pb-10">
            <div className="flex w-full max-w-[480px] items-center gap-3">{actions}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Title({ children, lead }: { children: ReactNode; lead?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h1 className="m-0 text-[28px] leading-[34px] font-normal tracking-[-0.02em]">{children}</h1>
      {lead && <p className="text-fg-dim m-0 max-w-[52ch] text-[15px] leading-6">{lead}</p>}
    </div>
  );
}
