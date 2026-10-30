import type { MenuItemConstructorOptions } from "electron";

export function appMenuTemplate({
  packaged,
  onFeedback,
}: {
  packaged: boolean;
  onFeedback: () => void;
}): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...(!packaged
          ? ([
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
              { type: "separator" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    { role: "help", submenu: [{ label: "Send feedback…", click: onFeedback }] },
  ];
}
