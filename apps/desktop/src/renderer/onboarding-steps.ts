// apps/desktop/src/renderer/onboarding-steps.ts
/** First run is four steps (spec §5, amended 2026-10-27). Sign in, apps and money are Home cards. */
export type Step = "welcome" | "control" | "protect" | "wallet";

export const STEPS: readonly Step[] = ["welcome", "control", "protect", "wallet"];

export const STEP_LABELS: Record<Step, string> = {
  welcome: "Welcome",
  control: "You are in control",
  protect: "Protect",
  wallet: "First agent wallet",
};

export function stepLabels(): readonly string[] {
  return STEPS.map((step) => STEP_LABELS[step]);
}

export function nextStep(step: Step): Step | undefined {
  return STEPS[STEPS.indexOf(step) + 1];
}

export type StepStatus = "done" | "current" | "todo";

/** Status of the step at `index` while `current` is open; the step list in `Frame` uses it. */
export function stepStatus(index: number, current: number): StepStatus {
  if (index < current) return "done";
  if (index === current) return "current";
  return "todo";
}
