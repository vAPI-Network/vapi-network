import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./check-copy.mjs", import.meta.url));

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "vapi-desktop-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), source);
  }
  return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
}

test("accepts desktop copy, protocol fields, comments, tests and the technical allowance", async (t) => {
  const result = await fixture(t, {
    "App.tsx": `// vault — robust
const state = { vault: status.vault };
export const App = () => <p title="Emergency Kit">Your agent wallet</p>;`,
    "ui/technical.tsx": 'export const Mono = () => <span className="font-mono">0x123</span>;',
    "ignored.test.tsx": "export const Example = () => <p>vault — robust</p>;",
    "ignored.ts": 'export const internal = "vault — robust";',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /passed across 2 source files/);
});

test("rejects desktop vocabulary, generic copy rules and non-allowlisted visual rules", async (t) => {
  const result = await fixture(t, {
    "Bad.tsx": `export const Bad = () => <p title="vault keystore">Seed mnemonic — robust VAPI</p>;
export const Code = () => <span className="font-mono uppercase text-[11px] text-fg-dimmer">Example</span>;`,
  });
  assert.equal(result.status, 1, result.stderr);
  for (const word of ["vault", "keystore", "Seed", "mnemonic"])
    assert.ok(result.stderr.includes(JSON.stringify(word)), result.stderr);
  for (const label of [
    "em dash",
    "AI-style hype term",
    "incorrect vAPI brand casing",
    "mono outside a technical context",
    "decorative uppercase utility",
    "text below 12px",
    "dimmest text outside optional metadata",
  ])
    assert.ok(result.stderr.includes(label), result.stderr);
  assert.match(result.stderr, /Bad\.tsx:1/);
});
