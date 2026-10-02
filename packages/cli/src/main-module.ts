import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Whether the process was started with this module as its entry point.
 *
 * npm installs `vapi` as a symlink into a global bin directory. Node resolves
 * the symlink for `import.meta.url` but leaves `process.argv[1]` as typed, so
 * the entry is compared by its real path, or a global install exits 0 without
 * running anything.
 */
export function isMainModule(
  entry: string | undefined,
  moduleUrl: string,
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (!entry) {
    return false;
  }
  try {
    return pathToFileURL(realpath(entry)).href === moduleUrl;
  } catch {
    return false;
  }
}
