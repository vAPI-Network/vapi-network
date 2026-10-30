import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// The dev server injects an inline React Refresh preamble and talks HMR over a
// websocket; the strict CSP in index.html would block both and leave a blank
// window. Built files keep the strict policy.
const devCsp = {
  name: "vapi-dev-csp",
  apply: "serve" as const,
  transformIndexHtml: (html: string) =>
    html
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
      .replace("connect-src 'none'", "connect-src 'self' ws://localhost:*"),
};

export default defineConfig({
  main: {
    define: { __VAPI_DESKTOP_SIGNED__: JSON.stringify(Boolean(process.env.CSC_LINK)) },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          signer: resolve(__dirname, "src/signer/index.ts"),
          "mcp-host": resolve(__dirname, "src/mcp-host/index.ts"),
        },
      },
    },
  },
  // Sandboxed preloads cannot be ES modules; "type": "module" would emit index.mjs.
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: { plugins: [react(), tailwindcss(), devCsp] },
});
