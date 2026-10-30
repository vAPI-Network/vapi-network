import { expect, it } from "vitest";
import { normalizePhrase, phraseWords } from "./phrase.js";

it("normalizes numbered, mixed-case, comma-separated and multiline Kit words", () => {
  expect(phraseWords("  1. Abandon, 2) ABILITY\n3. able\t4) about  ")).toEqual([
    "abandon",
    "ability",
    "able",
    "about",
  ]);
});
it("returns no words for empty input and preserves word order and repetitions", () => {
  expect(phraseWords(" \n, ")).toEqual([]);
  expect(phraseWords("able able about")).toEqual(["able", "able", "about"]);
});

it("joins normalized words for signer-side phrase validation", () => {
  expect(normalizePhrase("1. Abandon, 2) ABILITY\n3. able")).toBe("abandon ability able");
  expect(normalizePhrase("  ")).toBe("");
});
