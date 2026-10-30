import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Onboarding } from "./Onboarding.js";
import { Unlock } from "./Unlock.js";

describe("first-run screens", () => {
  it("opens with four setup labels and Get started in the bottom action row", () => {
    const html = renderToStaticMarkup(
      createElement(Onboarding, { start: "welcome", onDone: () => {}, onRestore: () => {} }),
    );
    const steps = html.match(/<ol[^>]*>(.*?)<\/ol>/)?.[1];
    expect(steps?.match(/<li /g)).toHaveLength(4);
    expect(steps).toContain("First agent wallet");
    expect(html.indexOf(">Get started<")).toBeGreaterThan(
      html.indexOf("shrink-0 px-10 pt-4 pb-10"),
    );
  });

  it("associates Protect's bottom submit action with the password form", () => {
    const html = renderToStaticMarkup(
      createElement(Onboarding, { start: "protect", onDone: () => {}, onRestore: () => {} }),
    );
    expect(html).toContain('id="protect-form"');
    expect(html).toContain('form="protect-form"');
    expect(html.indexOf('form="protect-form"')).toBeGreaterThan(html.indexOf("</form>"));
  });

  it("associates Unlock's bottom submit action with the password form", () => {
    const html = renderToStaticMarkup(createElement(Unlock, { onUnlocked: () => {} }));
    expect(html).toContain('id="unlock-form"');
    expect(html).toContain('form="unlock-form"');
    expect(html.indexOf('form="unlock-form"')).toBeGreaterThan(html.indexOf("</form>"));
    expect(html).not.toContain('aria-label="Setup steps"');
  });
});
