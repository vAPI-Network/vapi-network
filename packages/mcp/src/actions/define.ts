import { z } from "zod";

import type { ActionContext } from "./context.js";

export type ActionMoney = "spends" | "moves" | "none";

export type ActionGrant = "call" | "router" | "send" | "allocate" | "delegate" | "read";

export type Action<I, O> = {
  readonly name: string;
  readonly loopName: string;
  readonly description: string;
  readonly input: z.ZodObject<z.ZodRawShape>;
  readonly output: z.ZodType<O>;
  readonly money: ActionMoney;
  readonly grant: ActionGrant;
  run(input: I, ctx: ActionContext): Promise<O>;
};

export function toLoopName(name: string): string {
  return name.replaceAll(".", "_");
}

export function defineAction<I, O>(spec: Omit<Action<I, O>, "loopName">): Action<I, O> {
  return { ...spec, loopName: toLoopName(spec.name) };
}
