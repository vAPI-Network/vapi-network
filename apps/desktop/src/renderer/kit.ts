// apps/desktop/src/renderer/kit.ts
/** Two different words for "check that you wrote them down", 0-based and ascending. */
export function checkIndexes(count: number, random: () => number = Math.random): [number, number] {
  const first = Math.floor(random() * count);
  let second = Math.floor(random() * count);
  while (second === first) second = Math.floor(random() * count);
  return first < second ? [first, second] : [second, first];
}

export function wordMatches(words: readonly string[], index: number, answer: string): boolean {
  return words[index] !== undefined && words[index] === answer.trim().toLowerCase();
}

export { phraseWords } from "../shared/phrase.js";

export function phraseProblem(words: readonly string[]): string | undefined {
  return words.length === 12 || words.length === 24 ? undefined : "Enter all 12 or 24 words.";
}
