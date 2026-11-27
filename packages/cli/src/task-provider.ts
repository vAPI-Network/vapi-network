import { readFile } from "node:fs/promises";

import {
  formatBaseUnitsUsd,
  parseOfferPackage,
  providerOfferTask,
  providerProfileTask,
  type OfferView,
  type ProviderProfileOutcome,
} from "@vapi-network/core/tasks";

import { parseArguments, UsageError, type CliDependencies, type CliIo } from "./cli.js";
import { readTaskFile, signedIn, taskContext, taskOutput } from "./task.js";

type Parsed = ReturnType<typeof parseArguments>;

/** Provider verbs: the profile and the services a provider offers. Nothing here moves money. */
export const TASK_PROVIDER_VERBS = ["profile", "offer"] as const;

export const TASK_PROVIDER_OPTIONS = {
  profile: {
    value: ["--name", "--bio", "--skill", "--language", "--location", "--photo"],
    boolean: ["--remove-photo"],
    repeatable: ["--skill", "--language"],
  },
  offer: {
    value: ["--title", "--description", "--package", "--category", "--skill"],
    boolean: ["--pause", "--resume"],
    repeatable: ["--package", "--skill"],
  },
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function readText(
  path: string,
  dependencies: CliDependencies,
  readStdin: () => Promise<string>,
): Promise<string> {
  if (path === "-") return await (dependencies.readStdin ?? readStdin)();
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new UsageError(`${JSON.stringify(path)} could not be read.`);
  }
}

function days(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

function offerLines(offers: readonly OfferView[]): string[] {
  if (!offers.length) return ["No services yet. Publish one with vapi task offer --title …."];
  return offers.flatMap((offer) => [
    `${offer.id} · ${offer.title} · ${offer.active ? "live" : "paused"}`,
    ...offer.packages.map(
      (item) =>
        `  ${item.tier} · $${formatBaseUnitsUsd(item.priceBaseUnits)} USDC · ${days(item.deliveryTimeSeconds)} · ${item.summary}`,
    ),
  ]);
}

function profileLines(outcome: ProviderProfileOutcome, baseUrl: string): string[] {
  const { profile, verification } = outcome;
  if (!profile)
    return [
      verification.summary,
      "Create one with vapi task profile --name <name> --bio <file|-> --skill <what you do>.",
    ];
  return [
    ...(outcome.action === "created"
      ? ["Provider profile created. It is live now."]
      : outcome.action === "updated"
        ? ["Provider profile updated."]
        : []),
    `${profile.displayName} · ${profile.skills.join(", ")}`,
    ...(profile.location ? [`Location: ${profile.location}`] : []),
    ...(profile.languages.length ? [`Languages: ${profile.languages.join(", ")}`] : []),
    `Photo: ${profile.photoFileId ? "set" : "none"}`,
    `Verification: ${verification.summary}`,
    ...(verification.verified || verification.status === "taken-down"
      ? []
      : verification.checks.map((check) => `  ${check.title}: ${check.detail}`)),
    `Public profile: ${new URL(`/tasks/vendors/${profile.id}`, baseUrl).href}`,
    ...(outcome.action === "read" ? ["Services:", ...offerLines(outcome.offers)] : []),
  ];
}

export async function taskProviderCommand(
  verb: (typeof TASK_PROVIDER_VERBS)[number],
  parsed: Parsed,
  json: boolean,
  io: CliIo,
  dependencies: CliDependencies,
  readStdin: () => Promise<string>,
): Promise<number | undefined> {
  if (verb === "profile") {
    if (parsed.one("--photo") !== undefined && parsed.has("--remove-photo"))
      throw new UsageError("--photo and --remove-photo cannot be used together.");
    const bioPath = parsed.one("--bio");
    const photoPath = parsed.one("--photo");
    const changes = {
      ...(parsed.one("--name") === undefined ? {} : { displayName: parsed.one("--name")! }),
      ...(bioPath === undefined ? {} : { bio: await readText(bioPath, dependencies, readStdin) }),
      ...(parsed.many("--skill").length ? { skills: parsed.many("--skill") } : {}),
      ...(parsed.many("--language").length ? { languages: parsed.many("--language") } : {}),
      ...(parsed.one("--location") === undefined ? {} : { location: parsed.one("--location")! }),
      ...(photoPath === undefined ? {} : { photo: await readTaskFile(photoPath) }),
      ...(parsed.has("--remove-photo") ? { removePhoto: true } : {}),
    };
    const context = await taskContext(parsed, io, dependencies);
    signedIn(context);
    const outcome = await providerProfileTask(context, changes);
    taskOutput(io, json, context, verb, outcome, profileLines(outcome, context.baseUrl));
    return;
  }

  const id = parsed.positionals[0];
  if (id !== undefined && !UUID.test(id)) throw new UsageError("<offerId> must be a UUID.");
  if (parsed.has("--pause") && parsed.has("--resume"))
    throw new UsageError("--pause and --resume cannot be used together.");
  const descriptionPath = parsed.one("--description");
  const changes = {
    ...(id === undefined ? {} : { id: id.toLowerCase() }),
    ...(parsed.one("--title") === undefined ? {} : { title: parsed.one("--title")! }),
    ...(descriptionPath === undefined
      ? {}
      : { description: await readText(descriptionPath, dependencies, readStdin) }),
    ...(parsed.many("--package").length
      ? { packages: parsed.many("--package").map(parseOfferPackage) }
      : {}),
    ...(parsed.one("--category") === undefined ? {} : { category: parsed.one("--category")! }),
    ...(parsed.many("--skill").length ? { skills: parsed.many("--skill") } : {}),
    ...(parsed.has("--pause") ? { paused: true } : parsed.has("--resume") ? { paused: false } : {}),
  };
  const context = await taskContext(parsed, io, dependencies);
  signedIn(context);
  const outcome = await providerOfferTask(context, changes);
  if (outcome.action === "list") {
    taskOutput(io, json, context, verb, outcome, offerLines(outcome.offers));
    return;
  }
  const { offer } = outcome;
  taskOutput(io, json, context, verb, outcome, [
    outcome.action === "created"
      ? `Service published: ${offer.id}. Hiring it moves money only when the buyer funds escrow.`
      : `Service updated: ${offer.id}.`,
    ...offerLines([offer]),
    `Service page: ${new URL(`/tasks/services/${offer.id}`, context.baseUrl).href}`,
  ]);
  return;
}
