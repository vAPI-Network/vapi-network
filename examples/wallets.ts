/**
 * The wallet manager through the SDK: list what this machine holds, create a
 * capped wallet for an agent, and re-cap an existing one.
 *
 * Run it with `pnpm example:wallets -- agent-demo`. Nothing here prints a
 * secret: `create` returns a recovery phrase, and this example deliberately
 * shows the user where to read it instead of writing it to a terminal an agent
 * may be watching.
 */
import {
  WalletStore,
  formatUsdc,
  getVapiPaths,
  resolvePassphrase,
  usdToAtomic,
} from "@vapi-network/core";

const name = process.argv[2] ?? "agent-demo";

const store = await WalletStore.open(getVapiPaths().directory);

// list() reads addresses and caps out of the keystores without opening them,
// so nothing below needs a passphrase.
console.log("Wallets on this machine:");
for (const wallet of await store.list()) {
  const caps = `${formatUsdc(BigInt(wallet.spendCaps.perCallAtomic))} per call, ${formatUsdc(
    BigInt(wallet.spendCaps.perDayAtomic),
  )} per day`;
  console.log(
    [
      wallet.isDefault ? "*" : " ",
      wallet.name.padEnd(16),
      (wallet.address ?? "no address").padEnd(44),
      caps,
      wallet.label ?? "",
    ].join(" "),
  );
}

if (store.has(name)) {
  console.log(`\nWallet ${name} already exists; lowering its caps instead of creating it.`);
} else {
  console.log(`\nCreating wallet ${name}. Choose a passphrase for it:`);
  const { passphrase } = await resolvePassphrase(name, { confirm: true });
  const created = await store.create(name, passphrase, {
    label: "created by examples/wallets.ts",
    spendCaps: { perCallAtomic: String(usdToAtomic(0.05)), perDayAtomic: String(usdToAtomic(1)) },
  });
  console.log(`Created ${created.name} at ${created.account.address}.`);
  console.log(`Write its recovery phrase down with: vapi backup --wallet ${created.name}`);
}

// Caps belong to the wallet, so an agent's allowance is independent of yours.
const capped = await store.setSpendCaps(name, {
  perCallAtomic: String(usdToAtomic(0.02)),
  perDayAtomic: String(usdToAtomic(0.5)),
});
console.log(
  `${name} may now spend ${formatUsdc(BigInt(capped.spendCaps.perCallAtomic))} per call and ${formatUsdc(
    BigInt(capped.spendCaps.perDayAtomic),
  )} per day.`,
);
console.log(`Unlock it for an agent with: vapi unlock --wallet ${name}`);
