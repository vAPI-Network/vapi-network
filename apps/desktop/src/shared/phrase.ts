/** Pasted Kits may include numbering, commas, capitals and line breaks. */
export function phraseWords(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/\d+[.)]/g, " ")
    .split(/[\s,]+/)
    .filter((word) => word.length > 0);
}

export function normalizePhrase(input: string): string {
  return phraseWords(input).join(" ");
}
