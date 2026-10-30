import { useState } from "react";

import { Alert, Button, Field } from "../ui/primitives.js";
import { Frame, Title } from "./Frame.js";

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    const result = await window.desktop.signer({ type: "unlock", password });
    setBusy(false);
    if (result.ok) onUnlocked();
    else setError(result.message);
  }

  return (
    <Frame
      actions={
        <Button type="submit" form="unlock-form" busy={busy} disabled={password.length === 0}>
          Unlock
        </Button>
      }
    >
      <Title lead="Your non-custodial agent wallet manager. The keys stay on this Mac, and your agents cannot pay while it is locked.">
        Welcome back
      </Title>
      <form
        id="unlock-form"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Password"
          type="password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error && <Alert tone="error">{error}</Alert>}
      </form>
    </Frame>
  );
}
