export const FEEDBACK_ADDRESS = "founders@vapinetwork.ai";

export function feedbackMailto(info: { version: string; macos: string }): string {
  const subject = "vAPI Desktop beta feedback";
  const body = `vAPI Desktop ${info.version}\nmacOS ${info.macos}\n\nWhat happened:\n\n`;
  return `mailto:${FEEDBACK_ADDRESS}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
