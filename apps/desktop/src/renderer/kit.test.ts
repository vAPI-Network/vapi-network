import { describe, expect, it } from "vitest";

import { checkIndexes, phraseProblem, phraseWords, wordMatches } from "./kit.js";

describe("kit", () => {
  it("picks two different words to check", () => {
    const values = [0.1, 0.1, 0.9];
    expect(checkIndexes(12, () => values.shift() ?? 0)).toEqual([1, 10]);
    for (let run = 0; run < 50; run += 1) {
      const [a, b] = checkIndexes(12);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(12);
    }
  });

  it("matches a typed word loosely", () => {
    expect(wordMatches(["abandon", "ability"], 1, "  Ability ")).toBe(true);
    expect(wordMatches(["abandon", "ability"], 1, "able")).toBe(false);
    expect(wordMatches(["abandon", "ability"], 2, "ability")).toBe(false);
  });

  it("reads pasted words", () => {
    expect(phraseWords("1. Abandon\n2. ability, able")).toEqual(["abandon", "ability", "able"]);
    expect(phraseWords("  1) Abandon\t2) ABILITY,\n")).toEqual(["abandon", "ability"]);
    expect(phraseWords("  ")).toEqual([]);
    expect(phraseProblem(phraseWords("abandon ability"))).toBe("Enter all 12 or 24 words.");
    expect(phraseProblem(Array(12).fill("abandon"))).toBeUndefined();
    expect(phraseProblem(Array(24).fill("abandon"))).toBeUndefined();
    expect(phraseProblem(Array(13).fill("abandon"))).toBe("Enter all 12 or 24 words.");
  });
});
