import { createElement, type SVGProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import * as exportedIcons from "./icons.js";

const { DomainIcon, ICON_STROKE: _stroke, ...glyphs } = exportedIcons;

it("Home renders a house with straight roof, walls and door", () => {
  const svg = renderToStaticMarkup(createElement(exportedIcons.Home));
  expect(svg).toContain("lucide-house");
  expect(svg).not.toContain("<rect");
  expect(svg).toContain('d="M3 10.5 12 3l9 7.5V21H3z"');
  expect(svg).toContain('d="M9.5 21v-6h5v6"');
});

const icons = [
  ...Object.entries(glyphs).map(([name, Icon]) => ({
    name,
    render: (props: SVGProps<SVGSVGElement> = {}) =>
      renderToStaticMarkup(createElement(Icon, props)),
  })),
  ...(["agent", "mcp", "receipt"] as const).map((name) => ({
    name: `DomainIcon(${name})`,
    render: (props: SVGProps<SVGSVGElement> = {}) =>
      renderToStaticMarkup(createElement(DomainIcon, { ...props, name })),
  })),
];

describe.each(icons)("$name", ({ render }) => {
  it("uses the vAPI stroke and square geometry", () => {
    const svg = render();
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).toContain('stroke-linecap="square"');
    expect(svg).toContain('stroke-linejoin="miter"');
    expect(svg).not.toMatch(/\sr[xy]=/);
  });

  it("ignores caller overrides of the stroke contract", () => {
    const svg = render({ strokeWidth: 9, strokeLinecap: "round", strokeLinejoin: "round" });
    expect(svg).toContain('stroke-width="1.75"');
    expect(svg).toContain('stroke-linecap="square"');
    expect(svg).toContain('stroke-linejoin="miter"');
    expect(svg).not.toMatch(/\sr[xy]=/);
  });
});
