/**
 * The vAPI lockup from the brand kit (apps/web/public/branding/kit/logos/vapi-lockup-color-*.svg).
 * Ink parts use currentColor so one SVG serves light and dark.
 */
export function VapiLockup({ height = 22 }: { height?: number }) {
  return (
    <svg
      viewBox="0 0 189.2 70"
      height={height}
      width={(height * 189.2) / 70}
      role="img"
      aria-label="vAPI"
      className="text-foreground block"
    >
      <g transform="translate(0 14) scale(0.084977)">
        <rect x="1" y="1" width="92" height="219" fill="#ff7300" />
        <rect x="93" y="1" width="37" height="219" fill="#ff337c" />
        <rect x="130" y="1" width="18" height="219" fill="#c3ff3d" />
        <rect x="521" y="1" width="221" height="219" fill="currentColor" />
        <rect x="123" y="220" width="52" height="219" fill="#97efff" />
        <rect x="175" y="220" width="26" height="219" fill="#0041eb" />
        <rect x="201" y="220" width="19" height="219" fill="#8a37fb" />
        <rect x="401" y="220" width="221" height="219" fill="#0041eb" />
        <rect x="281" y="439" width="221" height="219" fill="currentColor" />
      </g>
      <path
        d="M75.90 70L67.20 70L88.80 0L103.60 0L125.20 70L116.50 70L111.10 52.30L81.30 52.30L75.90 70ZM95.50 5.10L83.50 44.70L108.90 44.70L96.90 5.10L95.50 5.10Z"
        fill="currentColor"
      />
      <path
        d="M136.60 70L128.20 70L128.20 0L155 0Q161.20 0 166.20 2.40Q171.200 4.80 174.10 9.35Q177 13.90 177 20.30L177 20.30L177 21.60Q177 27.90 174.05 32.45Q171.10 37 166.10 39.40Q161.10 41.80 155 41.80L155 41.80L136.60 41.80L136.60 70ZM136.60 7.60L136.60 34.20L154.10 34.20Q160.80 34.20 164.70 30.85Q168.60 27.50 168.60 21.40L168.60 21.40L168.60 20.40Q168.60 14.30 164.75 10.95Q160.90 7.60 154.10 7.60L154.10 7.60L136.60 7.60Z"
        fill="currentColor"
      />
      <path d="M189.20 70L180.80 70L180.80 0L189.20 0L189.20 70Z" fill="currentColor" />
    </svg>
  );
}

/** Lockup plus the product name, used top left in the sidebar and on first-run panels. */
export function DesktopBrand({ height = 22 }: { height?: number }) {
  return (
    <span className="flex items-end gap-2">
      <VapiLockup height={height} />
      <span className="text-fg-dim text-[14px] leading-none font-medium">Desktop</span>
    </span>
  );
}

// Same geometry as VapiLockup; `slot` is the block's place in the assembly cascade
// (the console's boot loader order, apps/api/app/_shared/client/brand/vapi-mark.ts).
const BLOCKS = [
  { x: 1, y: 1, width: 92, height: 219, fill: "#ff7300", slot: 0 },
  { x: 93, y: 1, width: 37, height: 219, fill: "#ff337c", slot: 1 },
  { x: 130, y: 1, width: 18, height: 219, fill: "#c3ff3d", slot: 2 },
  { x: 521, y: 1, width: 221, height: 219, fill: "currentColor", slot: 1 },
  { x: 123, y: 220, width: 52, height: 219, fill: "#97efff", slot: 3 },
  { x: 175, y: 220, width: 26, height: 219, fill: "#0041eb", slot: 4 },
  { x: 201, y: 220, width: 19, height: 219, fill: "#8a37fb", slot: 5 },
  { x: 401, y: 220, width: 221, height: 219, fill: "#0041eb", slot: 4 },
  { x: 281, y: 439, width: 221, height: 219, fill: "currentColor", slot: 7 },
] as const;
const SLOT_MS = 70;

/** Full-window loader: the mark's blocks assemble and dissolve in a loop until `done` fades it out. */
export function BootLoader({ done, label }: { done: boolean; label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className={`vapi-boot bg-background text-foreground fixed inset-0 z-50 flex items-center justify-center ${
        done ? "is-done" : ""
      }`}
    >
      <svg viewBox="0 0 189.2 70" width={240} height={(240 * 70) / 189.2} aria-hidden>
        <g transform="translate(0 14) scale(0.084977)">
          {BLOCKS.map((block) => (
            <rect
              key={`${block.x}:${block.y}`}
              x={block.x}
              y={block.y}
              width={block.width}
              height={block.height}
              fill={block.fill}
              style={{ animationDelay: `${block.slot * SLOT_MS}ms` }}
            />
          ))}
        </g>
        <g fill="currentColor">
          <path d="M75.90 70L67.20 70L88.80 0L103.60 0L125.20 70L116.50 70L111.10 52.30L81.30 52.30L75.90 70ZM95.50 5.10L83.50 44.70L108.90 44.70L96.90 5.10L95.50 5.10Z" />
          <path d="M136.60 70L128.20 70L128.20 0L155 0Q161.20 0 166.20 2.40Q171.20 4.80 174.10 9.35Q177 13.90 177 20.30L177 21.60Q177 27.90 174.05 32.45Q171.10 37 166.10 39.40Q161.10 41.80 155 41.80L136.60 41.80L136.60 70ZM136.60 7.60L136.60 34.20L154.10 34.20Q160.80 34.20 164.70 30.85Q168.60 27.50 168.60 21.40L168.60 20.40Q168.60 14.30 164.75 10.95Q160.90 7.60 154.10 7.60L136.60 7.60Z" />
          <path d="M189.20 70L180.80 70L180.80 0L189.20 0L189.20 70Z" />
        </g>
      </svg>
    </div>
  );
}
