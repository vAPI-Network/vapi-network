// apps/desktop/src/renderer/ui/icons.tsx
import { createElement, forwardRef, type SVGProps } from "react";
import {
  ChevronDown as LucideChevronDown,
  ChevronRight as LucideChevronRight,
  ChevronsUpDown as LucideChevronsUpDown,
  createLucideIcon,
  Link2 as LucideLink2,
  Plus as LucidePlus,
  SlidersHorizontal as LucideSlidersHorizontal,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

/**
 * The vAPI icon style, as on the website and console
 * (apps/api/app/_shared/client/components/icons/{domain-icon,lucide}.tsx):
 * 24×24, stroke 1.75, square caps, miter joins, no rounding, at most one solid
 * tessera. 16 in tags, 20 in navigation and buttons, 24 in empty states.
 * Copied rather than imported because apps/api is not a package; move both to
 * a shared package when a third app needs them.
 */
export const ICON_STROKE = {
  strokeWidth: 1.75,
  strokeLinecap: "square",
  strokeLinejoin: "miter",
} as const;

/** A Lucide glyph drawn the vAPI way. */
function squared(Icon: LucideIcon): LucideIcon {
  const Squared = forwardRef<SVGSVGElement, LucideProps>(
    (
      {
        absoluteStrokeWidth: _absoluteStrokeWidth,
        strokeWidth: _strokeWidth,
        strokeLinecap: _strokeLinecap,
        strokeLinejoin: _strokeLinejoin,
        ...props
      },
      ref,
    ) => <Icon ref={ref} size={20} {...props} {...ICON_STROKE} />,
  );
  Squared.displayName = `Squared(${Icon.displayName ?? "Icon"})`;
  return Squared as LucideIcon;
}

// Local square-cornered geometry, as in the console's lucide.tsx.
const SquareHome = createLucideIcon("house", [
  ["path", { d: "M3 10.5 12 3l9 7.5V21H3z", key: "home-outline" }],
  ["path", { d: "M9.5 21v-6h5v6", key: "home-door" }],
]);
const SquareLock = createLucideIcon("lock", [
  ["rect", { width: "18", height: "11", x: "3", y: "11", key: "lock-body" }],
  ["path", { d: "M7 11V2h10v9", key: "lock-shackle" }],
]);
const SquarePanelLeft = createLucideIcon("panel-left", [
  ["rect", { width: "18", height: "18", x: "3", y: "3", key: "panel-frame" }],
  ["path", { d: "M9 3v18", key: "panel-divider" }],
]);

export const ChevronDown = squared(LucideChevronDown);
export const ChevronRight = squared(LucideChevronRight);
export const ChevronsUpDown = squared(LucideChevronsUpDown);
export const Home = squared(SquareHome);
export const Link2 = squared(LucideLink2);
export const Lock = squared(SquareLock);
export const PanelLeft = squared(SquarePanelLeft);
export const Plus = squared(LucidePlus);
export const Settings = squared(LucideSlidersHorizontal);

type IconNode = readonly [tag: "rect" | "path", attrs: Readonly<Record<string, string>>];
const SOLID = { fill: "currentColor", stroke: "none" } as const;

// Inner markup copied exactly from domain-icon.tsx (agent :49, mcp :67, receipt :70).
const DOMAIN_ICON_NODES = {
  agent: [
    ["rect", { x: "5", y: "5", width: "14", height: "14" }],
    ["path", { d: "M12 5V3.5M9.5 10.5v3M14.5 10.5v3" }],
    ["rect", { x: "11", y: "2", width: "2", height: "2", ...SOLID }],
  ],
  mcp: [
    ["rect", { x: "3", y: "7", width: "10", height: "10" }],
    ["path", { d: "M13 9h8M13 15h8" }],
  ],
  receipt: [["path", { d: "M6 3h12v16.75l-3-3-3 3-3-3-3 3ZM10 7h4M10 11h4" }]],
} as const satisfies Record<string, readonly IconNode[]>;

export type DomainIconName = keyof typeof DOMAIN_ICON_NODES;

/** vAPI's own icons (agent, MCP app, receipt), same drawing contract. */
export function DomainIcon({
  name,
  size = 20,
  strokeWidth: _strokeWidth,
  strokeLinecap: _strokeLinecap,
  strokeLinejoin: _strokeLinejoin,
  ...rest
}: { name: DomainIconName; size?: 16 | 20 | 24 } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      aria-hidden
      {...rest}
      {...ICON_STROKE}
    >
      {DOMAIN_ICON_NODES[name].map(([tag, attrs], index) =>
        createElement(tag, { key: index, ...attrs }),
      )}
    </svg>
  );
}
