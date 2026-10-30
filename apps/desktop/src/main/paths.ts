import { join } from "node:path";

export type DesktopPaths = {
  root: string;
  socket: string;
  signerLedger: string;
  /** The custody terms the user accepted, with the time (main's own record). */
  custody: string;
};

/** `appData` is Electron's `app.getPath("appData")`; everything of ours sits in one folder under it. */
export function desktopPaths(appData: string): DesktopPaths {
  const root = join(appData, "vAPI Desktop");
  return {
    root,
    socket: join(root, "mcp.sock"),
    signerLedger: join(root, "signer-ledger.json"),
    custody: join(root, "custody-acknowledgement.json"),
  };
}
