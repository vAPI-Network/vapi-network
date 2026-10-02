import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { isMainModule } from "./main-module.js";

const dirs: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "vapi-main-module-"));
  dirs.push(dir);
  const real = join(dir, "cli.js");
  writeFileSync(real, "");
  const link = join(dir, "vapi");
  symlinkSync(real, link);
  // Node reports the resolved path in import.meta.url (on macOS the temp dir
  // itself sits behind the /var -> /private/var symlink).
  return { real, link, url: pathToFileURL(realpathSync(real)).href };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("isMainModule", () => {
  it("runs when started through the npm bin symlink", () => {
    const { link, url } = fixture();
    expect(isMainModule(link, url)).toBe(true);
  });

  it("runs when started by its real path", () => {
    const { real, url } = fixture();
    expect(isMainModule(real, url)).toBe(true);
  });

  it("does not run when imported by another entry point", () => {
    const { url } = fixture();
    const other = fixture();
    expect(isMainModule(other.real, url)).toBe(false);
  });

  it("does not run without an entry or when the entry cannot be resolved", () => {
    const { url } = fixture();
    expect(isMainModule(undefined, url)).toBe(false);
    expect(isMainModule("/does/not/exist", url)).toBe(false);
  });
});
