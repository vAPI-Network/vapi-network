#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// Ported from vapi-app/scripts/check-public-copy.mjs. Only renderer TSX rules
// belong here; web, API, Tasks, and console-only rules stay in that repo.
const COPY_RULES = [
  {
    label: "em dash",
    pattern: /—/g,
  },
  {
    label: "incorrect vAPI brand casing",
    pattern: /(?<![A-Za-z0-9_])VAPI(?![A-Za-z0-9_])/g,
  },
  {
    // The Graph's brand rule: "Subgraph" is capitalized in copy. URL paths
    // (/subgraphs/id/) and endpoint ids (query_subgraph) keep their casing.
    label: "lowercase Subgraph",
    pattern: /(?<![/\w])subgraphs?\b/g,
  },
  {
    label: "removed marketplace fee comparison",
    pattern: /\b19\s*[-–]\s*28\s*%|\b(?:Fiverr|Upwork)\b.{0,80}\b(?:fee|charge|percent|%)/gi,
  },
  {
    label: "unpublished audit claim",
    pattern: /\baudited\b|\baudit complete\b/gi,
  },
  {
    label: "false user-signed voucher claim",
    pattern: /\buser[- ]signed vouchers?\b|\bvouchers? you sign\b/gi,
  },
  {
    label: "false blanket custody claim",
    pattern:
      /\bfully non[- ]custodial\b|\bfunds never leave your wallet\b|\bvAPI (?:cannot|can't) charge your (?:funds|wallet)\b|\bescrow without (?:a )?custodian\b/gi,
  },
  {
    label: "false private-inference claim",
    pattern:
      /\bprompts? and completions? (?:are|is) never readable by vAPI\b|\bprompts? (?:are|is) never (?:stored|seen|read)\b/gi,
  },
  {
    label: "retired public product surface",
    pattern:
      /\b(?:Judge|Demo|Chat)\b(?=\s+(?:product|beta|pilot|service|jobs?|reviews?|pricing|route|API|runtime))|(?<![A-Za-z0-9])\/(?:demo|chat)\b/g,
  },
  {
    label: "retired hosted payment surface",
    pattern:
      /\bpayment channels?\b|\bhosted (?:wallet|balance)\b|\b(?:deposit|withdraw).{0,40}\b(?:channel|vAPI balance)\b|\/(?:wallet|channels?)(?=["'`\s?#]|$)/gi,
  },
  {
    label: "false blanket platform fee",
    pattern: /\b(?:flat|single|one) 5% (?:platform |protocol |network )?fee\b/gi,
  },
  {
    label: "retired Call network fee",
    // Legacy rows must still disclose the immutable fee on their payout path.
    pattern: /\b5 ?% (?:vAPI |network )?fee\b|(?<!legacy )\bpayout splitter\b/gi,
  },
  {
    label: "inactive Compute presented as live",
    pattern:
      /\bcurrent Compute prototype\b|\bsaved Compute (?:history|threads?)\b|\bCompute prompt routing\b.{0,40}\b(?:is|remains) active\b/gi,
  },
  {
    label: "unsupported permanent-deletion claim",
    pattern: /\bpermanently deleted\b/gi,
  },
  {
    label: "AI-style hype term",
    pattern:
      /\b(?:delve|foster|leverage|utilize|facilitate|empower|streamline|robust|cutting-edge|paradigm shift|game changer|tapestry|realm|beacon|multifaceted|meticulous|intricate|paramount|transformative|elevate|embark|supercharge|harness|ever-evolving)\b/gi,
  },
  {
    label: "public placeholder",
    pattern:
      /\b(?:TBD|TBA|incorporation pending)\b|\bregistry (?:number|id).{0,24}\b(?:pending|unknown|TBD)\b/gi,
  },
  {
    label: "demo catalog identifier",
    pattern:
      /\b(?:openrouter|perplexity|firecrawl|bloom-flowers|barista-run|proxycurl|browserbase|wolfram|audit-sol|design-brief)\b|\bslug\s*:\s*["']coingecko["']/gi,
  },
  {
    label: "vendor-specific integration artifact",
    pattern: /\bclaude\s+mcp\s+add\b/gi,
  },
  {
    label: "dynamic staking claim",
    // "Stake vAPI" names the real product, not a dynamic staking or yield claim.
    pattern:
      /\bpublic staking\b|\bstaking (?:vault|deposits?|rewards?|epochs?|positions?)\b|\b(?:unstake|staking rewards?)\b|\bpremium credits?\b|\blower markup\b|\bpriority (?:provider )?access\b/gi,
  },
  {
    label: "legacy governance name",
    pattern: /\bDAO\b/g,
  },
];

const VISUAL_RULES = [
  {
    label: "decorative uppercase utility",
    pattern: /\buppercase\b/g,
  },
  {
    label: "text below 12px",
    pattern: /\btext-\[(?:[0-9]|1[01])px\]|font-size:\s*(?:[0-9]|1[01])px\b/g,
  },
  {
    label: "mono outside a technical context",
    pattern: /\bfont-mono\b/g,
  },
  {
    label: "dimmest text outside optional metadata",
    pattern: /\btext-fg-dimmer\b/g,
  },
];

// Wallet addresses and device codes use this single technical component.
const VISUAL_ALLOWLIST = {
  "ui/technical.tsx": ["mono outside a technical context"],
};

const desktopVocabulary = /\b(?:vaults?|keystores?|seeds?|mnemonics?)\b/gi;

function stripNonPublicSource(source) {
  const mask = (text) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/<!--[\s\S]*?-->/g, mask)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, mask)
    .replace(/\/\*[\s\S]*?\*\//g, mask)
    .replace(/^\s*\/\/.*$/gm, mask);
}

// Scan vocabulary in text and literals so protocol fields such as status.vault
// stay valid. Parse TSX rather than treating identifiers or comments as copy.
function vocabularyRanges(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ranges = [];
  function visit(node) {
    if (ts.isJsxText(node)) ranges.push([node.getStart(parsed), node.end]);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ranges.push([node.getStart(parsed) + 1, node.end - 1]);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node))
      ranges.push([node.getStart(parsed) + 1, node.end - 2]);
    else if (ts.isTemplateTail(node)) ranges.push([node.getStart(parsed) + 1, node.end - 1]);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return ranges;
}

export async function checkCopy(rendererRoot) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && file.endsWith(".tsx") && !/\.test\.[^.]+$/.test(file))
        files.push(file);
    }
  }
  await walk(rendererRoot);
  const violations = [];
  for (const file of files.sort()) {
    const local = relative(rendererRoot, file).split("\\").join("/");
    const name = `apps/desktop/src/renderer/${local}`;
    const raw = await readFile(file, "utf8");
    const source = stripNonPublicSource(raw);
    function record(label, match, offset = 0) {
      violations.push({
        file: name,
        line: raw.slice(0, offset + match.index).split("\n").length,
        label,
        match: match[0],
      });
    }
    for (const rule of [...COPY_RULES, ...VISUAL_RULES]) {
      if (VISUAL_ALLOWLIST[local]?.includes(rule.label)) continue;
      for (const match of source.matchAll(rule.pattern)) record(rule.label, match);
    }
    for (const [start, end] of vocabularyRanges(raw, file)) {
      for (const match of raw.slice(start, end).matchAll(desktopVocabulary))
        record("desktop wallet vocabulary", match, start);
    }
  }
  return { files: files.length, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const rendererRoot =
    process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer");
  const result = await checkCopy(rendererRoot);
  if (result.violations.length) {
    console.error(`Desktop copy check found ${result.violations.length} violation(s):`);
    for (const { file, line, label, match } of result.violations)
      console.error(`${file}:${line}  ${label}  ${JSON.stringify(match)}`);
    process.exitCode = 1;
  } else {
    console.log(`Desktop copy check passed across ${result.files} source files.`);
  }
}
