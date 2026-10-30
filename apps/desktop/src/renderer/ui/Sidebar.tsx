// apps/desktop/src/renderer/ui/Sidebar.tsx
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import type { Overview } from "../../shared/overview.js";
import {
  accountLine,
  isCurrent,
  NAV_ITEMS,
  walletNodes,
  type AccountLine,
  type NavItem,
  type Page,
} from "../nav.js";
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  DomainIcon,
  Home,
  Link2,
  Lock,
  PanelLeft,
  Plus,
  Settings,
} from "./icons.js";
import { DesktopBrand } from "./Logo.js";
import { Monogram } from "./primitives.js";

/** 20 px navigation icons in the vAPI style; Activity and Apps use vAPI's own receipt and MCP marks. */
const NAV_ICONS: Record<NavItem["id"], ReactNode> = {
  new: <Plus />,
  home: <Home />,
  activity: <DomainIcon name="receipt" />,
  apps: <DomainIcon name="mcp" />,
};

/** Claude-Desktop-style sidebar: actions, pages, then You → agent wallets → apps (spec §3). */
export function Sidebar({
  overview,
  page,
  onNavigate,
  onLock,
  onCollapse,
}: {
  overview: Overview | undefined;
  page: Page;
  onNavigate: (page: Page) => void;
  onLock: () => void;
  onCollapse: () => void;
}) {
  const nodes = walletNodes(overview, page);
  return (
    <aside className="border-line bg-surface-2 flex min-h-0 flex-col border-r">
      <div className="app-drag flex h-[52px] shrink-0 items-center justify-end pr-2 pl-[84px]">
        <IconButton label="Hide sidebar" onClick={onCollapse}>
          <PanelLeft />
        </IconButton>
      </div>
      <nav
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3"
        aria-label="vAPI Desktop"
      >
        <div className="px-2.5 pb-4">
          <DesktopBrand />
        </div>
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <SidebarItem
                icon={NAV_ICONS[item.id]}
                label={item.label}
                current={isCurrent(page, item.id)}
                onClick={() => onNavigate({ kind: item.id })}
              />
            </li>
          ))}
        </ul>
        <Section id="wallets" title="Agent wallets">
          {nodes.map((node) => (
            <li key={node.name}>
              <SidebarItem
                icon={<Monogram name={node.name} size={18} />}
                label={node.name}
                detail={node.balance}
                current={node.selected}
                {...(node.link === undefined
                  ? {}
                  : {
                      dot:
                        node.link === "linked"
                          ? { tone: "live" as const, label: "Linked" }
                          : { tone: "attention" as const, label: "Not linked" },
                    })}
                onClick={() => onNavigate({ kind: "wallet", name: node.name })}
              />
              {node.apps.length > 0 && (
                <ul className="border-line m-0 ml-[19px] list-none border-l p-0 pl-2">
                  {node.apps.map((app) => (
                    <li
                      key={app}
                      className="text-fg-dim flex h-8 items-center gap-2 px-2 text-[13px]"
                    >
                      <span className="bg-lime size-1.5" aria-hidden />
                      {app}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </Section>
      </nav>
      <AccountFooter account={accountLine(overview)} onNavigate={onNavigate} onLock={onLock} />
    </aside>
  );
}

function SidebarItem({
  icon,
  label,
  detail,
  current,
  dot,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  current: boolean;
  dot?: { tone: "live" | "attention"; label: string };
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current || undefined}
      className={`relative flex h-9 w-full items-center gap-2.5 px-2.5 text-left text-[14px] transition-colors ${
        current
          ? "bg-pressed-surface text-foreground"
          : "text-fg-dim hover:bg-hover-surface hover:text-foreground"
      }`}
    >
      {current && (
        <span
          className="bg-orange absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2"
          aria-hidden
        />
      )}
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {dot && (
        <span
          role="img"
          aria-label={dot.label}
          title={dot.label}
          className={`size-1.5 shrink-0 ${dot.tone === "live" ? "bg-lime" : "bg-orange"}`}
        />
      )}
      {detail && <span className="text-fg-dim shrink-0 text-[12px] tabular-nums">{detail}</span>}
    </button>
  );
}

/** A collapsible group like Claude's "Pinned ▾"; the open state survives restarts. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const key = `vapi-desktop.sidebar.${id}.open`;
  const [open, setOpen] = useState(() => window.localStorage.getItem(key) !== "false");
  return (
    <section className="mt-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          window.localStorage.setItem(key, String(!open));
          setOpen(!open);
        }}
        className="text-fg-dim hover:text-foreground flex h-7 items-center gap-1 px-2.5 text-[12px] font-medium"
      >
        {title}
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open && <ul className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0">{children}</ul>}
    </section>
  );
}

function AccountFooter({
  account,
  onNavigate,
  onLock,
}: {
  account: AccountLine;
  onNavigate: (page: Page) => void;
  onLock: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("mousedown", outside);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("keydown", escape);
    };
  }, [open, close]);
  const go = (page: Page) => {
    close();
    onNavigate(page);
  };

  return (
    <div
      ref={root}
      onBlur={(event) => {
        if (
          !trigger.current?.contains(event.relatedTarget) &&
          !menu.current?.contains(event.relatedTarget)
        ) {
          setOpen(false);
        }
      }}
      className="border-line relative flex items-center gap-1 border-t px-2 py-2"
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="hover:bg-hover-surface flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
      >
        <span className="bg-pressed-surface text-foreground flex size-7 shrink-0 items-center justify-center text-[12px] font-medium">
          {account.initial}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium">{account.title}</span>
          <span className="text-fg-dim truncate text-[12px]">{account.subtitle}</span>
        </span>
        <ChevronsUpDown size={16} className="text-fg-dim shrink-0" />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          className="bg-toast-surface border-line absolute right-2 bottom-full left-2 mb-1 flex flex-col border py-1 shadow-lg"
        >
          <MenuItem icon={Settings} onClick={() => go({ kind: "settings" })}>
            Settings
          </MenuItem>
          {account.connect && (
            <MenuItem icon={Link2} onClick={() => go({ kind: "account" })}>
              Connect your vAPI account
            </MenuItem>
          )}
          <MenuItem
            icon={Lock}
            onClick={() => {
              close();
              onLock();
            }}
          >
            Lock vAPI Desktop
          </MenuItem>
        </div>
      )}
      <IconButton label="Lock vAPI Desktop" onClick={onLock}>
        <Lock />
      </IconButton>
    </div>
  );
}

function MenuItem({
  icon: Icon,
  onClick,
  children,
}: {
  icon: LucideIcon;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="hover:bg-hover-surface flex h-9 items-center gap-2.5 px-3 text-left text-[14px]"
    >
      <Icon size={16} className="text-fg-dim" />
      {children}
    </button>
  );
}

export function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="app-no-drag text-fg-dim hover:bg-hover-surface hover:text-foreground flex size-8 items-center justify-center"
    >
      {children}
    </button>
  );
}
