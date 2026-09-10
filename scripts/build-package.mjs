import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { build } from "esbuild";

const packageRoot = process.cwd();
const repositoryRoot = resolve(packageRoot, "../..");
const entries = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (separator <= 0 || separator === argument.length - 1) {
      throw new Error(`Expected build entry as name=path; received ${JSON.stringify(argument)}.`);
    }
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);

if (Object.keys(entries).length === 0) {
  throw new Error("At least one build entry is required.");
}

await rm(resolve(packageRoot, "dist"), { recursive: true, force: true });
const require = createRequire(import.meta.url);
await run(process.execPath, [
  require.resolve("typescript/bin/tsc"),
  "-p",
  resolve(packageRoot, "tsconfig.build.json"),
]);

const result = await build({
  absWorkingDir: packageRoot,
  entryPoints: entries,
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  sourcesContent: false,
  legalComments: "none",
  metafile: true,
  packages: "bundle",
});

const leakedRuntimeImports = Object.entries(result.metafile.outputs).flatMap(([output, metadata]) =>
  metadata.imports
    .filter((dependency) => dependency.external && !dependency.path.startsWith("node:"))
    .map((dependency) => `${output}: ${dependency.path}`),
);
if (leakedRuntimeImports.length > 0) {
  throw new Error(
    `Build left package imports in self-contained dist:\n${leakedRuntimeImports.join("\n")}`,
  );
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit ${code}`}.`));
    });
  });
}
