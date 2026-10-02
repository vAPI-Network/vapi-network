export type RunBudget = {
  id: string;
  limitAtomic: bigint;
  spentAtomic(): bigint;
  reservedAtomic(reservationId: string): bigint;
  reserve(amountAtomic: bigint, reservationId: string): void;
  release(reservationId: string): void;
};

export class RunBudgetError extends Error {
  readonly name = "RunBudgetError";
  readonly code = "run_budget_exceeded";
}

export function createRunBudget(args: { limitAtomic: bigint; id: string }): RunBudget {
  if (args.limitAtomic < 0n) throw new Error("Run budget limit must be non-negative.");

  const reservations = new Map<string, bigint>();
  let spent = 0n;

  return {
    id: args.id,
    limitAtomic: args.limitAtomic,
    spentAtomic: () => spent,
    reservedAtomic: (reservationId) => reservations.get(reservationId) ?? 0n,
    reserve(amountAtomic, reservationId) {
      if (amountAtomic < 0n) throw new Error("Run budget reservation amount must be non-negative.");
      if (reservations.has(reservationId)) {
        throw new Error(`Run budget reservation ${reservationId} already exists.`);
      }
      if (spent + amountAtomic > args.limitAtomic) {
        throw new RunBudgetError(
          `Cannot reserve ${amountAtomic} atomic USDC: spent ${spent} atomic USDC, limit ${args.limitAtomic} atomic USDC.`,
        );
      }
      reservations.set(reservationId, amountAtomic);
      spent += amountAtomic;
    },
    release(reservationId) {
      const amountAtomic = reservations.get(reservationId);
      if (amountAtomic === undefined) return;
      reservations.delete(reservationId);
      spent -= amountAtomic;
    },
  };
}
