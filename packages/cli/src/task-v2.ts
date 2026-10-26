import { readFile } from "node:fs/promises";
import { getVapiPaths, spendCapsForWallet } from "@vapi-network/core";
import { registeredAgentProfileSchema } from "@vapi-network/mcp";
import {
  executeTaskV2,
  taskUsesV2,
  taskPolicyForWallet,
  taskV2ActionSchema,
  taskV2ConsentSchema,
  taskV2ProofSchema,
  taskV2StepSchema,
  taskV2IndexSchema,
  recoverTaskV2,
  type TaskV2Action,
  type TaskV2Consent,
} from "@vapi-network/core/tasks";
import { taskContext, TaskCommandError } from "./task.js";
import { parseArguments, UsageError, type CliDependencies, type CliIo } from "./cli.js";

type Parsed = ReturnType<typeof parseArguments>;
export async function taskV2Command(
  verb: string,
  id: string,
  parsed: Parsed,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number | undefined | null> {
  const explicit =
    ["milestone", "cancel", "claim"].includes(verb) ||
    ["--worker", "--winners", "--action", "--index", "--operation"].some(
      (flag) => parsed.one(flag) !== undefined,
    );
  if (
    !explicit &&
    ![
      "fund",
      "refund",
      "deliver",
      "release",
      "dispute",
      "counter-evidence",
      "resolve-unmatched",
    ].includes(verb)
  )
    return null;
  const context = await taskContext(parsed, io, dependencies);
  if (!explicit && !(await taskUsesV2(context, id))) return null;
  const target = context.target;
  if (!context.token || !target)
    throw new TaskCommandError(
      "not_signed_in",
      "Sign-in is needed for the acting wallet. Run vapi login.",
    );
  if (verb === "status" && parsed.one("--operation")) {
    const operationId = parsed.one("--operation")!;
    const step = taskV2StepSchema.safeParse(parsed.one("--step"));
    if (!step.success) throw new UsageError("--step must be a hosted v2- operation step.");
    const result = await recoverTaskV2(context, {
      id,
      operationId,
      step: step.data,
      abandon: parsed.has("--abandon"),
    });
    io.stdout(
      json
        ? JSON.stringify({ command: "task status", ...result })
        : `Operation ${operationId}: ${result.operation?.state ?? "abandoned"}.`,
    );
    return;
  }
  let write: TaskV2Action | undefined, consent: TaskV2Consent | undefined;
  const index = () => {
    const raw = parsed.one("--index");
    const value = raw !== undefined && /^\d+$/u.test(raw) ? Number(raw) : NaN;
    if (!taskV2IndexSchema.safeParse(value).success)
      throw new UsageError("--index must be a zero-based C0 index from 0 to 4.");
    return value;
  };
  const proof = async () => {
    const proofFile = parsed.one("--proof-json");
    if (proofFile) {
      try {
        return taskV2ProofSchema.parse(JSON.parse(await readFile(proofFile, "utf8")));
      } catch {
        throw new UsageError("--proof-json must contain a hosted ProofFill array.");
      }
    }
    const values: Array<{ preset: "link" | "file" | "text"; value: string }> = parsed
      .many("--proof")
      .map((value) => ({ preset: "link", value }));
    for (const path of [...parsed.many("--file"), ...parsed.many("--files")]) {
      const file = await context.client.uploadFile({
        fileName: path.split("/").at(-1)!,
        bytes: await readFile(path),
      });
      values.push({ preset: "file", value: file.file.sha256 });
    }
    const note = parsed.one("--note");
    if (note) values.push({ preset: "text", value: note });
    const result = taskV2ProofSchema.safeParse(values);
    if (!result.success)
      throw new UsageError("Supply delivery with --proof, --file, --note or --proof-json.");
    return result.data;
  };
  try {
    if (verb === "milestone") {
      const action = parsed.positionals[1];
      write = taskV2ActionSchema.parse({
        action,
        i: index(),
        ...(action === "submit" ? { proof: await proof() } : {}),
        ...(action === "reject" ? { reason: parsed.one("--reason") } : {}),
      });
      if (!["submit", "approve", "reject", "finalize"].includes(action!))
        throw new UsageError("Milestone action must be submit, approve, reject or finalize.");
    } else if (verb === "cancel") {
      const scope = parsed.positionals[1];
      if (!["offer", "remainder", "expire"].includes(scope!))
        throw new UsageError("Cancel scope must be offer, remainder or expire.");
      write = taskV2ActionSchema.parse({
        action: scope === "expire" ? "expire" : `cancel-${scope}`,
      });
    } else if (verb === "award") {
      if (
        parsed.positionals[1] ||
        Boolean(parsed.one("--worker")) === Boolean(parsed.one("--winners"))
      )
        throw new UsageError(
          "Award requires exactly one of --worker or --winners, or a V1 proposalId.",
        );
      write = taskV2ActionSchema.parse(
        parsed.one("--worker")
          ? { action: "award", worker: parsed.one("--worker") }
          : { action: "award-bounty", winners: parsed.one("--winners")!.split(",") },
      );
    } else if (verb === "sign") {
      const action = parsed.one("--action");
      consent = taskV2ConsentSchema.parse({
        action,
        ...(action === "split-consent" ? { i: index(), toWorker: parsed.one("--to-worker") } : {}),
      });
    } else if (verb === "claim")
      write = taskV2ActionSchema.parse({ action: "pay-claim", claimant: parsed.one("--claimant") });
    else if (["dispute", "counter-evidence", "resolve-unmatched"].includes(verb)) {
      const action = verb === "dispute" ? (parsed.one("--action") ?? "raise") : verb;
      write = taskV2ActionSchema.parse({
        action: action === "raise" ? "raise-dispute" : action,
        i: index(),
        ...(action === "raise" || action === "counter-evidence"
          ? { evidence: parsed.one("--evidence") }
          : {}),
        ...(action === "split" ? { toWorker: parsed.one("--to-worker") } : {}),
      });
    } else if (verb === "deliver" || verb === "release") {
      const view = await context.client.getOrder(id);
      if (view.workOrder.terms?.milestones?.length !== 1)
        throw new UsageError(
          "Use vapi task milestone --index for a task with multiple milestones.",
        );
      write = taskV2ActionSchema.parse({
        action: verb === "deliver" ? "submit" : parsed.has("--finalize") ? "finalize" : "approve",
        i: 0,
        ...(verb === "deliver" ? { proof: await proof() } : {}),
      });
    } else write = taskV2ActionSchema.parse({ action: verb });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      `Invalid V2 ${verb} arguments: ${error instanceof Error ? error.message : "invalid input"}`,
    );
  }
  const policy = await taskPolicyForWallet({
    directory: getVapiPaths().directory,
    wallet: target.name,
    schema: registeredAgentProfileSchema,
  });
  try {
    const result = await executeTaskV2(context, {
      id,
      ...(write ? { write } : {}),
      ...(consent ? { consent } : {}),
      policy,
      caps: await spendCapsForWallet(target.store, target.name),
      wallet: target.name,
      ledgerPath: getVapiPaths().ledger,
      approval: { granted: parsed.has("--yes") },
      onMoney: (money) => {
        io.stderr(money.line);
      },
    });
    io.stdout(
      json
        ? JSON.stringify({
            command: `task ${verb}`,
            wallet: target.name,
            ...result,
          })
        : result.ok
          ? `Hosted ${"operation" in result ? (result.operation?.state ?? "pending") : "consent"} for task ${id}.`
          : `Task action refused: ${"reason" in result ? result.reason : "approval required"}.`,
    );
    return result.ok ? undefined : "approval" in result ? 3 : 2;
  } catch (error) {
    if (
      !explicit &&
      error instanceof Error &&
      "code" in error &&
      ["v1_order", "v2_writes_disabled"].includes(String(error.code))
    )
      return null;
    throw error;
  }
}
