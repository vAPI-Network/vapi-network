// apps/desktop/src/renderer/screens/ConnectAccount.tsx
import { useState } from "react";

import { LinkApproval } from "../ui/LinkApproval.js";
import { Alert, Button, Tabs } from "../ui/primitives.js";
import { useLinkFlow } from "../useLinkFlow.js";

/**
 * "Connect your vAPI account" (spec §4). A vAPI account is the wallet a person
 * signs in to the console with (D2). The app links one agent wallet to it
 * through the console's /link page; the signer does the work (D7).
 */
export function ConnectAccount({
  wallet,
  onDone,
  onSkip,
}: {
  wallet: string | undefined;
  onDone: () => void;
  onSkip: () => void;
}) {
  const [path, setPath] = useState<"existing" | "new">("existing");
  const { flow, now, start, openConsole } = useLinkFlow(wallet);

  if (wallet === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-fg-dim m-0">
          Connecting links an agent wallet to your account. Create an agent wallet first, then
          connect from home.
        </p>
        <div>
          <Button onClick={onSkip}>Continue</Button>
        </div>
      </div>
    );
  }

  if (flow.kind === "linked") {
    return (
      <div className="flex flex-col gap-4">
        <Alert tone="success">Connected. {wallet} is linked to your vAPI account.</Alert>
        <div>
          <Button onClick={onDone}>Continue</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {flow.kind !== "browser" && (
        <Tabs
          tabs={[
            { id: "existing", label: "I have a vAPI account" },
            { id: "new", label: "I'm new" },
          ]}
          value={path}
          onChange={setPath}
        />
      )}
      {flow.kind !== "browser" && (
        <p className="text-fg-dim m-0">
          {path === "existing"
            ? `The console opens in your browser. Sign in with your wallet and approve ${wallet}.`
            : "Sign-in uses a crypto wallet such as Coinbase Wallet. Install a wallet first if you have none. It takes a minute."}
        </p>
      )}
      <LinkApproval
        flow={flow}
        now={now}
        onStart={() => void start()}
        onOpenConsole={() => void openConsole()}
        onSkip={onSkip}
      />
      {flow.kind === "idle" && (
        <p className="text-fg-dim m-0 text-[13px]">You can connect later from home.</p>
      )}
    </div>
  );
}
