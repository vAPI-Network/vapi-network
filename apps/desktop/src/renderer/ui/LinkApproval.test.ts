import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { afterOpenFailed, type LinkFlow } from "../link-flow.js";
import { LinkApproval } from "./LinkApproval.js";

const browser: LinkFlow = {
  kind: "browser",
  userCode: "ABCD-EFGH",
  url: "https://untrusted.example/link?code=ABCD-EFGH",
  expiresAt: 10_000,
};

function render(flow: LinkFlow): string {
  return renderToStaticMarkup(
    createElement(LinkApproval, {
      flow,
      now: 0,
      onStart: () => {},
      onOpenConsole: () => {},
    }),
  ).replace(/&#x27;/g, "'");
}

describe("LinkApproval open failure", () => {
  it("shows only the trusted manual link page beside the code after opening fails", () => {
    const html = render(afterOpenFailed(browser, "https://api-staging.vapinetwork.ai/link"));
    expect(html).toContain(
      "vAPI Desktop could not open the console. Go to this page and enter the code above:",
    );
    expect(html).toContain("https://api-staging.vapinetwork.ai/link</span>");
    expect(html).toContain("break-all select-text");
    expect(html).toContain("ABCD-EFGH");
    expect(html).not.toContain(browser.url);
  });

  it("gives manual instructions without exposing the refused URL when no page is known", () => {
    const html = render(afterOpenFailed(browser));
    expect(html).toContain(
      "vAPI Desktop could not open the console. Open the vAPI console's link page and enter the code above.",
    );
    expect(html).toContain("ABCD-EFGH");
    expect(html).not.toContain(browser.url);
  });
});
