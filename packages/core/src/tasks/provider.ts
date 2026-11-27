import { z } from "zod";

import { parseUsdToBaseUnits } from "./money.js";
import { TaskInputError } from "./operation-support.js";

/**
 * Provider profiles and services (offers) on Tasks. A provider is the party who
 * delivers. vAPI's HTTP routes still call the profile a vendor profile and a
 * service a listing; this module keeps those wire names at the transport edge.
 * Nothing here signs or moves money.
 */

/** The three checks vAPI runs before a provider gets the Verified badge. */
export const TASK_PROVIDER_VERIFICATION_CHECKS = [
  { title: "vAPI ID", detail: "The wallet you sign in with holds a vAPI ID." },
  { title: "A work link", detail: "A portfolio, website or past work in your service." },
  { title: "One social account", detail: "An X, LinkedIn or GitHub account linked to you." },
] as const;

/** Languages vAPI accepts on a provider profile. */
export const TASK_PROVIDER_LANGUAGES = [
  "Arabic",
  "Bengali",
  "Chinese",
  "Dutch",
  "English",
  "French",
  "German",
  "Hindi",
  "Indonesian",
  "Italian",
  "Japanese",
  "Korean",
  "Polish",
  "Portuguese",
  "Russian",
  "Spanish",
  "Swahili",
  "Turkish",
  "Ukrainian",
  "Urdu",
] as const;

export const TASK_PROVIDER_PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const TASK_OFFER_TIERS = ["starter", "standard", "advanced"] as const;

/** Command spelling of the service categories; the wire uses underscores. */
export const TASK_OFFER_CATEGORIES = [
  "general-digital",
  "software-api",
  "research-data",
  "design-content",
] as const;

export const TASK_PROVIDER_LIMITS = {
  nameMin: 2,
  nameMax: 80,
  bioMin: 20,
  bioMax: 4_000,
  skillMax: 60,
  skillsMax: 20,
  languagesMax: 5,
  locationMin: 2,
  locationMax: 80,
  photoBytesMax: 5 * 1024 * 1024,
  offerTitleMin: 3,
  offerTitleMax: 120,
  offerDescriptionMin: 20,
  offerDescriptionMax: 8_000,
  packagesMax: 3,
  packageSummaryMin: 10,
  packageSummaryMax: 160,
  packageDeliveryMinSeconds: 3_600,
  packageDeliveryMaxSeconds: 7_776_000,
  offerSkillMax: 40,
  offerSkillsMax: 20,
} as const;

const L = TASK_PROVIDER_LIMITS;
const uuid = z.uuid();
const offerCategoryWire = z.enum([
  "general_digital",
  "software_api",
  "research_data",
  "design_content",
]);
const offerSkill = z
  .string()
  .max(L.offerSkillMax)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u, "Service skills use lowercase letters, digits, - or _");

export const providerProfileCreateInputSchema = z
  .object({
    displayName: z.string().trim().min(L.nameMin).max(L.nameMax),
    bio: z.string().trim().min(L.bioMin).max(L.bioMax),
    skills: z.array(z.string().trim().min(1).max(L.skillMax)).min(1).max(L.skillsMax),
    photoFileId: uuid.nullable().optional(),
  })
  .strict();

export const providerProfileUpdateInputSchema = z
  .object({
    bio: z.string().trim().min(L.bioMin).max(L.bioMax).optional(),
    languages: z.array(z.enum(TASK_PROVIDER_LANGUAGES)).max(L.languagesMax).optional(),
    location: z.string().trim().min(L.locationMin).max(L.locationMax).nullable().optional(),
    photoFileId: uuid.nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one profile field is required");

export const offerPackageSchema = z
  .object({
    tier: z.enum(TASK_OFFER_TIERS),
    summary: z.string().trim().min(L.packageSummaryMin).max(240),
    priceBaseUnits: z.string().regex(/^[1-9]\d*$/u, "Price must be a positive integer"),
    deliveryTimeSeconds: z
      .number()
      .int()
      .min(L.packageDeliveryMinSeconds)
      .max(L.packageDeliveryMaxSeconds),
    revisionCount: z.number().int().min(0).max(20).nullable(),
    inclusions: z.array(z.string().trim().min(2).max(160)).min(1).max(12),
  })
  .strict();

const offerPackagesSchema = z
  .array(offerPackageSchema)
  .min(1)
  .max(L.packagesMax)
  .refine(
    (packages) => new Set(packages.map((item) => item.tier)).size === packages.length,
    "Package tiers must be unique",
  );

const offerFields = {
  title: z.string().trim().min(L.offerTitleMin).max(L.offerTitleMax),
  description: z.string().trim().min(L.offerDescriptionMin).max(L.offerDescriptionMax),
  category: offerCategoryWire,
  network: z.string().regex(/^eip155:[1-9]\d*$/u, "Network must be a CAIP-2 EVM network"),
  asset: z.string().trim().min(1).max(160),
  packages: offerPackagesSchema,
  skills: z.array(offerSkill).max(L.offerSkillsMax),
  paused: z.boolean(),
};

export const offerCreateInputSchema = z
  .object({
    ...offerFields,
    skills: offerFields.skills.optional(),
    paused: offerFields.paused.optional(),
  })
  .strict();

export const offerUpdateInputSchema = z
  .object({
    title: offerFields.title.optional(),
    description: offerFields.description.optional(),
    category: offerFields.category.optional(),
    packages: offerFields.packages.optional(),
    skills: offerFields.skills.optional(),
    paused: offerFields.paused.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one service field is required");

const offerViewSchema = z.looseObject({
  id: uuid,
  title: z.string(),
  description: z.string(),
  category: z.string(),
  network: z.string(),
  asset: z.string(),
  packages: z.array(
    z.looseObject({
      tier: z.string(),
      summary: z.string(),
      priceBaseUnits: z.string(),
      deliveryTimeSeconds: z.number(),
    }),
  ),
  active: z.boolean(),
});

const providerProfileViewSchema = z.looseObject({
  id: uuid,
  walletAddress: z.string(),
  displayName: z.string(),
  bio: z.string(),
  skills: z.array(z.string()),
  languages: z.array(z.string()),
  location: z.string().nullable(),
  status: z.string(),
  verified: z.boolean(),
  photoFileId: z.string().nullable(),
  listings: z.array(offerViewSchema).optional(),
});

export const providerProfileResponseSchema = z.looseObject({
  vendorProfile: providerProfileViewSchema.nullable(),
});
export const providerProfileMutationResponseSchema = z.looseObject({
  vendorProfile: providerProfileViewSchema,
});
export const offerResponseSchema = z.looseObject({ listing: offerViewSchema });

export type ProviderProfileCreateInput = z.input<typeof providerProfileCreateInputSchema>;
export type ProviderProfileUpdateInput = z.input<typeof providerProfileUpdateInputSchema>;
export type OfferPackage = z.output<typeof offerPackageSchema>;
export type OfferCreateInput = z.input<typeof offerCreateInputSchema>;
export type OfferUpdateInput = z.input<typeof offerUpdateInputSchema>;
export type ProviderProfileView = z.output<typeof providerProfileViewSchema>;
export type OfferView = z.output<typeof offerViewSchema>;
export type ProviderProfileResponse = z.output<typeof providerProfileResponseSchema>;
export type ProviderProfileMutationResponse = z.output<
  typeof providerProfileMutationResponseSchema
>;
export type OfferResponse = z.output<typeof offerResponseSchema>;
export type TaskOfferTier = (typeof TASK_OFFER_TIERS)[number];
export type TaskOfferCategory = (typeof TASK_OFFER_CATEGORIES)[number];

/** Delivery time such as 90m, 48h or 7d; between one hour and 90 days. */
export function parseOfferDeliveryTime(text: string): number {
  const match = /^(\d{1,7})(m|h|d)$/u.exec(text.trim());
  const seconds = match
    ? Number(match[1]) * { m: 60, h: 3_600, d: 86_400 }[match[2] as "m" | "h" | "d"]
    : Number.NaN;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < L.packageDeliveryMinSeconds ||
    seconds > L.packageDeliveryMaxSeconds
  )
    throw new TaskInputError(
      "Delivery time must be minutes, hours or days such as 90m, 48h or 7d, between 1h and 90d.",
    );
  return seconds;
}

/**
 * One package of a service. The summary is also its single inclusion, as on the
 * website, so it stays within the inclusion limit of 160 characters.
 */
export function offerPackage(input: {
  tier: string;
  priceUsd: string;
  deliveryTime: string;
  summary: string;
}): OfferPackage {
  if (!(TASK_OFFER_TIERS as readonly string[]).includes(input.tier))
    throw new TaskInputError(`Package tier must be ${TASK_OFFER_TIERS.join(", ")}.`);
  let price: bigint;
  try {
    price = parseUsdToBaseUnits(input.priceUsd);
  } catch {
    throw new TaskInputError(
      `Package ${input.tier}: the price must be a USD amount with at most six decimals.`,
    );
  }
  if (price <= 0n) throw new TaskInputError(`Package ${input.tier}: the price must be positive.`);
  const summary = input.summary.trim();
  if (summary.length < L.packageSummaryMin || summary.length > L.packageSummaryMax)
    throw new TaskInputError(
      `Package ${input.tier}: say what is included in ${L.packageSummaryMin} to ${L.packageSummaryMax} characters.`,
    );
  return {
    tier: input.tier as TaskOfferTier,
    summary,
    priceBaseUnits: price.toString(),
    deliveryTimeSeconds: parseOfferDeliveryTime(input.deliveryTime),
    revisionCount: null,
    inclusions: [summary],
  };
}

/** Parses `<tier>:<usd>:<delivery time>:<summary>`; the summary may contain colons. */
export function parseOfferPackage(spec: string): OfferPackage {
  const [tier, priceUsd, deliveryTime, ...rest] = spec.split(":");
  if (tier === undefined || priceUsd === undefined || deliveryTime === undefined || !rest.length)
    throw new TaskInputError(
      "A package is <tier>:<usd>:<delivery time>:<summary>, for example starter:150:3d:One landing page with copy.",
    );
  return offerPackage({ tier, priceUsd, deliveryTime, summary: rest.join(":") });
}

export function offerCategory(value: string): z.output<typeof offerCategoryWire> {
  if (!(TASK_OFFER_CATEGORIES as readonly string[]).includes(value))
    throw new TaskInputError(`Category must be ${TASK_OFFER_CATEGORIES.join(", ")}.`);
  return value.replaceAll("-", "_") as z.output<typeof offerCategoryWire>;
}

/** Lowercases and de-duplicates service skill tags, then checks their shape. */
export function offerSkills(values: readonly string[]): string[] {
  const skills = [...new Set(values.map((value) => value.trim().toLowerCase()))];
  if (skills.length > L.offerSkillsMax)
    throw new TaskInputError(`A service takes at most ${L.offerSkillsMax} skills.`);
  for (const skill of skills)
    if (!offerSkill.safeParse(skill).success)
      throw new TaskInputError(
        `Skill ${JSON.stringify(skill)} must be at most ${L.offerSkillMax} lowercase letters, digits, - or _.`,
      );
  return skills;
}

/** Keeps the first spelling of each profile skill, ignoring case, as the website does. */
export function providerSkills(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const raw of values) {
    const skill = raw.trim();
    if (!skill || seen.has(skill.toLowerCase())) continue;
    if (skill.length > L.skillMax)
      throw new TaskInputError(`Keep each skill under ${L.skillMax + 1} characters.`);
    seen.add(skill.toLowerCase());
    skills.push(skill);
  }
  if (skills.length > L.skillsMax)
    throw new TaskInputError(`A profile takes at most ${L.skillsMax} skills.`);
  return skills;
}

export function providerLanguages(
  values: readonly string[],
): ProviderProfileUpdateInput["languages"] {
  const languages: (typeof TASK_PROVIDER_LANGUAGES)[number][] = [];
  for (const raw of values) {
    const language = TASK_PROVIDER_LANGUAGES.find(
      (item) => item.toLowerCase() === raw.trim().toLowerCase(),
    );
    if (!language)
      throw new TaskInputError(`Language must be one of ${TASK_PROVIDER_LANGUAGES.join(", ")}.`);
    if (!languages.includes(language)) languages.push(language);
  }
  if (languages.length > L.languagesMax)
    throw new TaskInputError(`A profile takes at most ${L.languagesMax} languages.`);
  return languages;
}

/** Verification as the profile page shows it. `pending` is live and not verified yet. */
export function providerVerification(profile: Pick<ProviderProfileView, "status"> | null) {
  const status =
    profile === null
      ? ("no-profile" as const)
      : profile.status === "approved"
        ? ("verified" as const)
        : profile.status === "rejected"
          ? ("taken-down" as const)
          : ("not-verified" as const);
  return {
    status,
    verified: status === "verified",
    summary: {
      "no-profile": "No provider profile yet.",
      verified: "Verified provider. The badge shows on your profile and services.",
      "taken-down": "This provider profile was taken down.",
      "not-verified":
        "Live, not verified yet. vAPI checks these three things for the Verified badge; you do not need to ask.",
    }[status],
    checks: TASK_PROVIDER_VERIFICATION_CHECKS.map((check) => ({ ...check })),
  };
}
