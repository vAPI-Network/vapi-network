import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { KitSheet } from "./KitSheet.js";

const words =
  "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");

describe("KitSheet", () => {
  it("numbers the words and carries the warnings, without a QR", () => {
    const html = renderToStaticMarkup(
      createElement(KitSheet, {
        words,
        date: "27 October 2026",
        wallets: [{ name: "claude", address: "0x8617E340B3D01FA5F11F306F4090FD50E238070D" }],
      }),
    );
    expect(html).toContain("kit-print");
    expect(html).toContain("1.</span>");
    expect(html).toContain("accident");
    expect(html).toContain("claude");
    expect(html).toContain("Anyone with these words can take the money");
    expect(html).toContain("not in this kit");
    expect(html).not.toMatch(/<svg|<img|canvas/);
    expect(html).not.toMatch(/vault|keystore|seed|mnemonic/i);
  });
});
