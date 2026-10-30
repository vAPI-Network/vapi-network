// apps/desktop/src/renderer/screens/Frame.test.ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { stepLabels } from "../onboarding-steps.js";
import { Frame } from "./Frame.js";

function render(props: { step?: { index: number; labels: readonly string[] }; actions?: string }) {
  return renderToStaticMarkup(
    createElement(Frame, {
      ...(props.step === undefined ? {} : { step: props.step }),
      ...(props.actions === undefined
        ? {}
        : { actions: createElement("button", { type: "button" }, props.actions) }),
      children: createElement("p", null, "content"),
    }),
  );
}

describe("Frame", () => {
  it("is a two-column layout on the window with no box around the content", () => {
    const html = render({});
    expect(html).toContain("grid-cols-[280px_1fr]");
    expect(html).toContain("max-w-[480px]");
    expect(html).not.toContain("max-w-[560px]");
    expect(html).not.toContain("justify-center");
    expect(html).not.toMatch(/class="[^"]*\bborder\b/);
    expect(html).not.toContain("shadow");
  });

  it("lists the steps on the left and marks the current one", () => {
    const html = render({ step: { index: 1, labels: stepLabels() } });
    expect(html).toContain('aria-label="Setup steps"');
    for (const label of stepLabels()) expect(html).toContain(label);
    expect(html).toContain('aria-current="step"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).not.toContain("Step 2 of");
  });

  it("shows no step list without a step, so unlock looks like setup", () => {
    const html = render({});
    expect(html).not.toContain("Setup steps");
    expect(html).toContain("Desktop");
  });

  it("puts the actions in a bottom row outside the scrolling column", () => {
    const html = render({ actions: "Continue" });
    const scroll = html.indexOf("overflow-y-auto");
    const content = html.indexOf("content");
    const button = html.indexOf(">Continue<");
    expect(scroll).toBeGreaterThan(-1);
    expect(content).toBeGreaterThan(scroll);
    expect(button).toBeGreaterThan(content);
    expect(html.slice(button - 400, button)).toContain("shrink-0");
  });
});
