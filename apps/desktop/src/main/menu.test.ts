import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import { appMenuTemplate } from "./menu.js";

function roles(items: MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.role ? [item.role] : []),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : []),
  ]);
}

describe("appMenuTemplate", () => {
  it("puts Send feedback in the Help menu", () => {
    const onFeedback = vi.fn();
    const help = appMenuTemplate({ packaged: true, onFeedback }).find(
      (item) => item.role === "help",
    );
    const submenu = help?.submenu as MenuItemConstructorOptions[];
    expect(submenu.map((item) => item.label)).toEqual(["Send feedback…"]);
    submenu[0]!.click?.(undefined as never, undefined, undefined as never);
    expect(onFeedback).toHaveBeenCalledOnce();
  });

  it("has no developer tools or reload in packaged builds", () => {
    const packaged = roles(appMenuTemplate({ packaged: true, onFeedback: vi.fn() }));
    expect(packaged).not.toContain("toggleDevTools");
    expect(packaged).not.toContain("reload");
    expect(packaged).not.toContain("forceReload");
    expect(roles(appMenuTemplate({ packaged: false, onFeedback: vi.fn() }))).toContain(
      "toggleDevTools",
    );
  });
});
