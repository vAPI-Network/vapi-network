import { useEffect, useState } from "react";
import { PanelLeft } from "../ui/icons.js";

import { DEFAULT_CAPS } from "../../shared/limits.js";
import { isWalletName } from "../../shared/wallet-name.js";
import { useCopyText } from "../useCopyText.js";
import { PageHeader } from "../ui/PageHeader.js";
import { SetupCard } from "../ui/SetupCard.js";
import { APP_LABELS } from "../../shared/apps.js";
import { appsForWallet } from "../apps.js";
import type { Overview, OverviewWallet } from "../../shared/overview.js";
import { formatUsd, shortAddress } from "../format.js";
import { linkPill, youRow } from "../link-flow.js";
import type { Page } from "../nav.js";
import { homeCards } from "../resume.js";
import { ActivityList } from "../ui/Activity.js";
import { AddMoney } from "../ui/AddMoney.js";
import { AppCards } from "../ui/AppCards.js";
import { LimitsEditor } from "../ui/Limits.js";
import { Badge, Button, Field, Monogram, SpendBar, Stat, Tabs } from "../ui/primitives.js";
import { IconButton, Sidebar } from "../ui/Sidebar.js";
import { Mono } from "../ui/technical.js";
import { WalletLink } from "../ui/WalletLink.js";
import { useOverview } from "../useOverview.js";
import { Backup } from "./Backup.js";
import { ConnectAccount } from "./ConnectAccount.js";
import { EmergencyKit } from "./EmergencyKit.js";
import { Settings } from "./Settings.js";

type WalletTab = "overview" | "fund" | "limits" | "activity" | "apps";
type LinkIntent = Extract<Page, { kind: "wallet" }>["link"];

const LOW_BALANCE_ATOMIC = 100_000n;

function total(wallets: OverviewWallet[]): string | null {
  if (wallets.some((wallet) => wallet.balanceAtomic === null)) return null;
  return wallets.reduce((sum, wallet) => sum + BigInt(wallet.balanceAtomic ?? "0"), 0n).toString();
}

function money(atomic: string | null): string {
  return atomic === null ? "Unavailable" : formatUsd(atomic);
}

export function Shell({ onLocked, initial }: { onLocked: () => void; initial?: Overview }) {
  const [page, setPage] = useState<Page>({ kind: "home" });
  const [tab, setTab] = useState<WalletTab>("overview");
  const [sidebar, setSidebar] = useState(true);
  const fast = page.kind === "wallet" && tab === "fund";
  const { overview, error, refresh } = useOverview(fast ? 5000 : 15000, initial);
  const [beta, setBeta] = useState<{ version: string; crashReports: boolean } | null>(null);
  const [betaBusy, setBetaBusy] = useState(false);
  const [betaError, setBetaError] = useState<string | null>(null);

  useEffect(() => {
    if (page.kind !== "settings") return;
    let cancelled = false;
    void Promise.all([window.desktop.appInfo(), window.desktop.preferences()]).then(
      ([info, preferences]) => {
        if (!cancelled) setBeta({ ...info, ...preferences });
      },
      () => {
        if (!cancelled)
          setBetaError("Could not read the app settings. Reopen vAPI Desktop to try again.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [page.kind]);

  async function betaAction(action: () => Promise<void>) {
    setBetaBusy(true);
    setBetaError(null);
    try {
      await action();
    } catch {
      setBetaError("Could not complete that. Try again.");
    } finally {
      setBetaBusy(false);
    }
  }

  async function setCrashReports(on: boolean) {
    await betaAction(async () => {
      const preferences = await window.desktop.setCrashReports(on);
      setBeta((current) => current && { ...current, ...preferences });
    });
  }

  async function lock() {
    const result = await window.desktop.signer({ type: "lock" });
    if (result.ok) onLocked();
  }

  function navigate(next: Page) {
    setPage(next);
    setTab("overview");
  }

  function openWallet(name: string, next: WalletTab = "overview", link?: LinkIntent) {
    setPage({ kind: "wallet", name, link });
    setTab(next);
  }

  const connected = youRow(overview?.owner ?? null, overview?.wallets ?? []).status === "Connected";
  const linkTarget =
    overview?.wallets.find((wallet) => wallet.link !== "linked")?.name ??
    overview?.wallets[0]?.name;
  const selectedWallet =
    page.kind === "wallet"
      ? overview?.wallets.find((wallet) => wallet.name === page.name)
      : undefined;

  return (
    <div className={`grid h-full ${sidebar ? "grid-cols-[280px_1fr]" : "grid-cols-[1fr]"}`}>
      {sidebar && (
        <Sidebar
          overview={overview}
          page={page}
          onNavigate={navigate}
          onLock={() => void lock()}
          onCollapse={() => setSidebar(false)}
        />
      )}
      <main className="bg-background flex min-w-0 flex-col">
        <div
          className={`app-drag flex h-[52px] shrink-0 items-center ${sidebar ? "" : "pl-[84px]"}`}
        >
          {!sidebar && (
            <IconButton label="Show sidebar" onClick={() => setSidebar(true)}>
              <PanelLeft />
            </IconButton>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[880px] flex-col gap-8 px-10 pb-9">
            {error && !overview && <p className="text-pink-text">{error}</p>}
            {!overview ? (
              <p className="text-fg-dim">Loading…</p>
            ) : page.kind === "home" ? (
              <Home
                overview={overview}
                onOpen={openWallet}
                onConnect={() => navigate({ kind: "account" })}
                onApps={() => navigate({ kind: "apps" })}
                onNew={() => navigate({ kind: "new" })}
                onKit={() => navigate({ kind: "kit" })}
                onBackup={() => navigate({ kind: "backup" })}
              />
            ) : page.kind === "activity" ? (
              <>
                <PageHeader
                  title="Activity"
                  lead="Every payment from every agent wallet, newest first."
                />
                <ActivityList items={overview.activity} showWallet />
              </>
            ) : page.kind === "apps" ? (
              <AppsPage overview={overview} onChanged={refresh} />
            ) : page.kind === "settings" ? (
              <Settings
                overview={overview}
                onConnect={() => navigate({ kind: "account" })}
                onLock={() => void lock()}
                onKit={() => navigate({ kind: "kit" })}
                onBackup={() => navigate({ kind: "backup" })}
                version={beta?.version ?? null}
                crashReports={beta?.crashReports ?? null}
                betaBusy={betaBusy}
                betaError={betaError}
                onFeedback={() => void betaAction(() => window.desktop.sendFeedback())}
                onCrashReports={(on) => void setCrashReports(on)}
                onShowReports={() => void betaAction(() => window.desktop.showCrashReports())}
              />
            ) : page.kind === "backup" ? (
              <Backup
                onDone={async () => {
                  await refresh();
                  navigate({ kind: "home" });
                }}
              />
            ) : page.kind === "kit" ? (
              <EmergencyKit
                overview={overview}
                onDone={async () => {
                  await refresh();
                  navigate({ kind: "home" });
                }}
              />
            ) : page.kind === "account" ? (
              <>
                <PageHeader
                  title="Connect your vAPI account"
                  lead="Your vAPI account is the wallet you sign in to the console with. Linking shows your agent wallets under My agents, where you can revoke them at any time."
                />
                <div className="flex max-w-[560px] flex-col gap-6">
                  <ConnectAccount
                    wallet={linkTarget}
                    onDone={async () => {
                      await refresh();
                      navigate({ kind: "home" });
                    }}
                    onSkip={() => navigate({ kind: "home" })}
                  />
                </div>
              </>
            ) : page.kind === "new" ? (
              <NewWallet
                onCreated={async (name) => {
                  await refresh();
                  // Spec §4 "First agent wallet": link at once when the account is connected.
                  openWallet(name, "fund", connected ? "created" : undefined);
                }}
              />
            ) : selectedWallet ? (
              <WalletDetail
                key={selectedWallet.name}
                wallet={selectedWallet}
                overview={overview}
                tab={tab}
                startOn={page.kind === "wallet" ? page.link : undefined}
                onTab={setTab}
                onSaved={() => void refresh()}
              />
            ) : (
              <p className="text-fg-dim">This wallet is gone.</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function AppsPage({ overview, onChanged }: { overview: Overview; onChanged: () => Promise<void> }) {
  const [selected, setSelected] = useState<string | undefined>();
  const wallet = overview.wallets.find((entry) => entry.name === selected) ?? overview.wallets[0];
  return (
    <>
      <PageHeader
        title="Apps"
        lead="Each app pays from one agent wallet. Pick the wallet, then connect."
      />
      {overview.wallets.length > 1 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Agent wallet">
          {overview.wallets.map((entry) => (
            <Button
              key={entry.name}
              variant={entry.name === wallet?.name ? "default" : "secondary"}
              aria-pressed={entry.name === wallet?.name}
              onClick={() => setSelected(entry.name)}
            >
              {entry.name}
            </Button>
          ))}
        </div>
      )}
      {wallet ? (
        <AppCards wallet={wallet.name} overview={overview} onChanged={onChanged} />
      ) : (
        <p className="text-fg-dim m-0">Create an agent wallet to connect an app.</p>
      )}
    </>
  );
}

function Home({
  overview,
  onOpen,
  onConnect,
  onApps,
  onNew,
  onKit,
  onBackup,
}: {
  overview: Overview;
  onOpen: (name: string, tab?: WalletTab, link?: LinkIntent) => void;
  onConnect: () => void;
  onApps: () => void;
  onNew: () => void;
  onKit: () => void;
  onBackup: () => void;
}) {
  const connectedApps = overview.apps.filter((status) => status.state === "connected");
  const cards = homeCards({
    owner: overview.owner,
    wallets: overview.wallets,
    apps: overview.apps,
    recovery: overview.recovery,
  });
  const first = overview.wallets[0];
  const spent = overview.wallets.reduce((sum, wallet) => sum + BigInt(wallet.spentTodayAtomic), 0n);
  const limit = overview.wallets.reduce(
    (sum, wallet) => sum + BigInt(wallet.caps.perDayAtomic),
    0n,
  );
  return (
    <>
      <PageHeader
        title="Your agent wallets"
        lead="These wallets are yours. The keys are encrypted on this Mac and vAPI cannot access or move them. Each agent can spend only up to the limits you set."
      />
      <section className="bg-line border-line grid grid-cols-3 gap-px border">
        <Stat label="Total balance" value={money(total(overview.wallets))}>
          <span className="text-fg-dim text-[13px]">USDC on Base</span>
        </Stat>
        <Stat label="Spent today" value={formatUsd(spent)}>
          <SpendBar spent={spent} limit={limit} />
          <span className="text-fg-dim text-[13px] tabular-nums">
            of {formatUsd(limit)} across all wallets
          </span>
        </Stat>
        <Stat label="Connected apps" value={String(connectedApps.length)}>
          <span className="text-fg-dim text-[13px]">
            {connectedApps.map((status) => APP_LABELS[status.id]).join(", ") || "None yet"}
          </span>
        </Stat>
      </section>

      {cards.map((card) => {
        switch (card) {
          case "firstWallet":
            return (
              <SetupCard
                key={card}
                title="Create your first agent wallet"
                body="An agent wallet is a separate balance with its own limits. Start with one for Claude."
                action={<Button onClick={onNew}>New agent wallet</Button>}
              />
            );
          case "connectAccount":
            return (
              <SetupCard
                key={card}
                title="Connect your vAPI account"
                body="Link your agent wallets to the wallet you sign in to the console with. They then show under My agents, where you can revoke them."
                action={<Button onClick={onConnect}>Connect</Button>}
              />
            );
          case "connectApp":
            return (
              <SetupCard
                key={card}
                title="Connect an app"
                body="Apps talk to vAPI Desktop through a small helper that forwards messages and holds no keys. Each app pays from one agent wallet."
                action={<Button onClick={onApps}>Connect an app</Button>}
              />
            );
          case "addMoney":
            return first ? (
              <SetupCard
                key={card}
                title="Add money"
                body="Put a few dollars in to start. Most API calls cost less than a cent."
                action={<Button onClick={() => onOpen(first.name, "fund")}>Add money</Button>}
              />
            ) : null;
          case "emergencyKit":
            return (
              <SetupCard
                key={card}
                title="Make your Emergency Kit"
                badge={<Badge tone="blocked">Not done</Badge>}
                body="Words on paper that bring your agent wallets back if you forget your password or lose this Mac. They work even without vAPI."
                action={<Button onClick={onKit}>Make the kit</Button>}
              />
            );
          case "backup":
            return (
              <SetupCard
                key={card}
                title="Turn on encrypted backup"
                body="A copy of your agent wallets, locked with a key only your vAPI account can open. vAPI stores it and cannot read it."
                action={<Button onClick={onBackup}>Turn on</Button>}
              />
            );
          case "backupFailed":
            return (
              <SetupCard
                key={card}
                title="Backup failed"
                body="The last encrypted backup did not reach vAPI. vAPI Desktop tries again after the next change."
                action={<Button onClick={onBackup}>Try again</Button>}
              />
            );
        }
      })}

      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-[18px] leading-6 font-medium">Agent wallets</h2>
        <div className="border-line border">
          {overview.wallets.map((wallet) => (
            <WalletRow
              key={wallet.name}
              wallet={wallet}
              connected={
                appsForWallet(overview.apps, wallet.name, overview.wallets[0]?.name).length > 0
              }
              onOpen={() => onOpen(wallet.name)}
              onFund={() => onOpen(wallet.name, "fund")}
              onLink={() => onOpen(wallet.name, "overview", "clicked")}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="m-0 text-[18px] leading-6 font-medium">Activity</h2>
        <ActivityList items={overview.activity.slice(0, 8)} showWallet />
      </section>
    </>
  );
}

function WalletRow({
  wallet,
  connected,
  onOpen,
  onFund,
  onLink,
}: {
  wallet: OverviewWallet;
  connected: boolean;
  onOpen: () => void;
  onFund: () => void;
  onLink: () => void;
}) {
  const pill = linkPill(wallet.link);
  const spent = BigInt(wallet.spentTodayAtomic);
  const perDay = BigInt(wallet.caps.perDayAtomic);
  const low = wallet.balanceAtomic !== null && BigInt(wallet.balanceAtomic) < LOW_BALANCE_ATOMIC;
  return (
    <div className="border-line hover:bg-hover-surface grid grid-cols-[minmax(0,1fr)_168px_auto] items-center gap-6 border-b px-5 py-4 transition-colors last:border-b-0">
      <button type="button" onClick={onOpen} className="flex min-w-0 items-center gap-4 text-left">
        <Monogram name={wallet.name} size={36} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[17px] leading-5 font-medium tracking-[-0.01em]">
            {wallet.name}
          </span>
          <Mono className="text-fg-dim text-[12px]">{shortAddress(wallet.address)}</Mono>
          {(connected || low || spent >= perDay || pill) && (
            // Status gets its own line so it never runs into the spend column.
            <span className="mt-1 flex flex-wrap gap-1.5">
              {pill && <Badge tone={pill.tone}>{pill.label}</Badge>}
              {connected && <Badge tone="live">Apps connected</Badge>}
              {low && <Badge tone="blocked">Low balance</Badge>}
              {spent >= perDay && <Badge tone="blocked">Limit reached</Badge>}
            </span>
          )}
        </span>
      </button>
      <div className="flex flex-col items-end gap-1.5">
        <span className="text-[17px] leading-5 font-medium tabular-nums">
          {money(wallet.balanceAtomic)}
        </span>
        <SpendBar spent={spent} limit={perDay} />
        <span className="text-fg-dim text-[12px] tabular-nums">
          {formatUsd(spent)} of {formatUsd(perDay)} spent today
        </span>
      </div>
      <div className="flex flex-col items-end gap-2">
        <Button variant="secondary" size="compact" onClick={onFund}>
          Add money
        </Button>
        {pill?.action && (
          <Button variant="secondary" size="compact" onClick={onLink}>
            {pill.action}
          </Button>
        )}
      </div>
    </div>
  );
}

function WalletDetail({
  wallet,
  overview,
  tab,
  startOn,
  onTab,
  onSaved,
}: {
  wallet: OverviewWallet;
  overview: Overview;
  tab: WalletTab;
  startOn?: LinkIntent;
  onTab: (tab: WalletTab) => void;
  onSaved: () => void;
}) {
  const { copy, copied, error: copyError } = useCopyText();
  const connectedApps = appsForWallet(overview.apps, wallet.name, overview.wallets[0]?.name);
  const spent = BigInt(wallet.spentTodayAtomic);
  const perDay = BigInt(wallet.caps.perDayAtomic);
  return (
    <>
      <header className="flex items-start gap-4">
        <Monogram name={wallet.name} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h1 className="m-0 text-[28px] leading-[34px] font-normal tracking-[-0.02em]">
            {wallet.name}
          </h1>
          <button
            type="button"
            className="text-fg-dim hover:text-foreground flex items-center gap-2 text-left text-[12px]"
            onClick={() => void copy(wallet.address)}
          >
            <Mono>{wallet.address}</Mono>
            <span className="text-[12px]">{copied ? "Copied" : "Copy"}</span>
          </button>
          {copyError && (
            <p role="alert" className="text-pink-text m-0 text-[12px]">
              Could not copy. Try again.
            </p>
          )}
          {wallet.link === "linked" && <Badge tone="live">Linked</Badge>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="text-[26px] leading-8 font-medium tracking-[-0.02em] tabular-nums">
            {money(wallet.balanceAtomic)}
          </span>
          <span className="text-fg-dim text-[13px]">USDC on Base</span>
        </div>
      </header>

      <WalletLink wallet={wallet.name} link={wallet.link} startOn={startOn} onLinked={onSaved} />

      <Tabs
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "fund", label: "Add money" },
          { id: "limits", label: "Limits" },
          { id: "activity", label: "Activity" },
          { id: "apps", label: "Apps" },
        ]}
        value={tab}
        onChange={onTab}
      />

      {tab === "overview" && (
        <div className="flex flex-col gap-8">
          <section className="bg-line border-line grid grid-cols-2 gap-px border">
            <Stat label="Spent today" value={formatUsd(spent)}>
              <SpendBar spent={spent} limit={perDay} />
              <span className="text-fg-dim text-[13px] tabular-nums">
                of {formatUsd(perDay)} per day
              </span>
            </Stat>
            <Stat label="Per payment" value={formatUsd(wallet.caps.perCallAtomic)}>
              <button
                type="button"
                className="text-link self-start text-[13px] underline-offset-4 hover:underline"
                onClick={() => onTab("limits")}
              >
                Change limits
              </button>
            </Stat>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-[18px] leading-6 font-medium">Apps using this wallet</h2>
            <p className="text-fg-dim m-0">
              {connectedApps.length > 0
                ? connectedApps.join(", ")
                : "No apps pay from this wallet yet."}
            </p>
            <button
              type="button"
              className="text-link self-start text-[13px] underline-offset-4 hover:underline"
              onClick={() => onTab("apps")}
            >
              Manage apps
            </button>
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="m-0 text-[18px] leading-6 font-medium">Recent activity</h2>
            <ActivityList
              items={overview.activity.filter((item) => item.wallet === wallet.name).slice(0, 5)}
              showWallet={false}
            />
          </section>
        </div>
      )}
      {tab === "fund" && <AddMoney key={wallet.name} wallet={wallet} />}
      {tab === "apps" && <AppCards wallet={wallet.name} overview={overview} onChanged={onSaved} />}
      {tab === "limits" && (
        <LimitsEditor
          key={`${wallet.name}:${wallet.caps.perCallAtomic}:${wallet.caps.perDayAtomic}`}
          walletName={wallet.name}
          initial={wallet.caps}
          current={wallet.caps}
          saveLabel="Save limits"
          onSave={async (caps, password) => {
            const result = await window.desktop.signer({
              type: "setCaps",
              wallet: wallet.name,
              caps,
              ...(password === undefined ? {} : { password }),
            });
            if (!result.ok) return result.message;
            onSaved();
            return undefined;
          }}
        />
      )}
      {tab === "activity" && (
        <ActivityList
          items={overview.activity.filter((item) => item.wallet === wallet.name)}
          showWallet={false}
        />
      )}
    </>
  );
}

function NewWallet({ onCreated }: { onCreated: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const valid = isWalletName(name);
  return (
    <>
      <PageHeader
        title="New agent wallet"
        lead="Each agent wallet has its own address, balance and limits. Use one per agent or per job. When your vAPI account is connected, the new wallet starts linking to it right away."
      />
      <div className="flex max-w-[560px] flex-col gap-6">
        <Field
          label="Name"
          autoFocus
          value={name}
          placeholder="research-bot"
          onChange={(event) => setName(event.target.value.toLowerCase())}
          hint="Lowercase letters, numbers and dashes."
        />
        <LimitsEditor
          walletName={valid ? name : "This wallet"}
          initial={DEFAULT_CAPS}
          saveLabel="Create agent wallet"
          onSave={async (caps) => {
            if (!valid) return "Choose a name first.";
            const result = await window.desktop.signer({ type: "createWallet", name, caps });
            if (!result.ok) return result.message;
            await onCreated(name);
            return undefined;
          }}
        />
      </div>
    </>
  );
}
