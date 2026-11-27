import {
  TaskInputError,
  TaskOperationError,
  requireTaskMethod,
  taskRequest,
  type TaskOperationContext,
} from "./operation-support.js";
import { TasksClientError } from "./client.js";
import {
  TASK_PROVIDER_LIMITS,
  TASK_PROVIDER_PHOTO_TYPES,
  offerCategory,
  offerSkills,
  providerLanguages,
  providerSkills,
  providerVerification,
  type OfferPackage,
  type OfferUpdateInput,
  type OfferView,
  type ProviderProfileUpdateInput,
  type ProviderProfileView,
} from "./provider.js";
import type { UploadFileInput } from "./types.js";

/** Codes the provider routes answer with HTTP 403 that are not a sign-in problem. */
const PROVIDER_REFUSALS: Readonly<Record<string, string>> = {
  approved_vendor_required:
    "This wallet has no live provider profile. Create one with vapi task profile --name <name> --bio <file> --skill <skill>, or call tasks.profile with displayName, bio and skills.",
  listing_not_owned: "Only the provider who published this service can change it.",
  provider_owner_wallet_required:
    "Linked agents cannot manage the owner's provider profile or services. The owner sets them up on the web, or the agent signs in with its own vAPI account.",
  vendor_profile_wallet_mismatch:
    "This provider profile belongs to another wallet. Act as the wallet that created it.",
  wallet_proof_required: "vAPI asks for a wallet proof first. Sign in again and retry.",
};

async function providerRequest<T>(
  verb: "profile" | "offer",
  route: Parameters<typeof taskRequest>[1],
  context: TaskOperationContext,
  operation: () => Promise<T>,
): Promise<T> {
  return await taskRequest(
    verb,
    route,
    async () => {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof TasksClientError && error.status === 403 && error.serverCode) {
          const refusal = PROVIDER_REFUSALS[error.serverCode];
          if (refusal) throw new TaskOperationError(error.serverCode, refusal);
        }
        throw error;
      }
    },
    context,
  );
}

/** The profile without its services; those are returned beside it as `offers`. */
function publicProfile(profile: ProviderProfileView | null): ProviderProfileView | null {
  if (profile === null) return null;
  const rest: Record<string, unknown> = { ...profile };
  delete rest.listings;
  return rest as ProviderProfileView;
}

export type ProviderProfileChanges = {
  displayName?: string;
  bio?: string;
  skills?: readonly string[];
  languages?: readonly string[];
  location?: string;
  photo?: UploadFileInput;
  removePhoto?: boolean;
};

export type ProviderProfileOutcome = {
  action: "read" | "created" | "updated";
  profile: ProviderProfileView | null;
  offers: OfferView[];
  verification: ReturnType<typeof providerVerification>;
  photoFileId?: string;
  movesMoney: false;
};

/** Checks a local photo before anything is uploaded. */
export function providerPhoto(file: UploadFileInput): UploadFileInput {
  if (!(TASK_PROVIDER_PHOTO_TYPES as readonly string[]).includes(file.contentType ?? ""))
    throw new TaskInputError("The profile photo must be a PNG, JPEG or WebP image.");
  if (file.bytes.byteLength < 1 || file.bytes.byteLength > TASK_PROVIDER_LIMITS.photoBytesMax)
    throw new TaskInputError("The profile photo must be at most 5 MB.");
  return { ...file, purpose: "avatar" };
}

/**
 * Reads, creates or updates the acting wallet's provider profile. Without changes it
 * only reads. A new profile is live at once; vAPI lists every unverified provider for
 * review, so there is nothing to request. Moves no money.
 */
export async function providerProfileTask(
  context: TaskOperationContext,
  changes: ProviderProfileChanges = {},
): Promise<ProviderProfileOutcome> {
  if (changes.photo && changes.removePhoto)
    throw new TaskInputError("A new photo and removing the photo cannot be combined.");
  const photo = changes.photo ? providerPhoto(changes.photo) : undefined;
  const skills = changes.skills === undefined ? undefined : providerSkills(changes.skills);
  const languages =
    changes.languages === undefined ? undefined : providerLanguages(changes.languages);
  const read = await providerRequest("profile", "providerProfile", context, () =>
    requireTaskMethod(context.client, "providerProfile")(),
  );
  const existing = read.vendorProfile;
  const offers = existing?.listings ?? [];
  const changing =
    changes.displayName !== undefined ||
    changes.bio !== undefined ||
    skills !== undefined ||
    languages !== undefined ||
    changes.location !== undefined ||
    photo !== undefined ||
    changes.removePhoto === true;
  if (!changing)
    return {
      action: "read",
      profile: publicProfile(existing),
      offers,
      verification: providerVerification(existing),
      movesMoney: false,
    };

  if (existing && (changes.displayName !== undefined || skills !== undefined))
    throw new TaskInputError(
      "vAPI does not change the name or skills of a live provider profile yet. Change the bio, languages, location or photo.",
    );
  if (!existing) {
    if (changes.removePhoto)
      throw new TaskInputError("There is no provider profile, so there is no photo to remove.");
    if (changes.displayName === undefined || changes.bio === undefined || !skills?.length)
      throw new TaskInputError(
        "A new provider profile needs a name, a bio and at least one skill. The first skill shows as your headline.",
      );
  }
  if (changes.bio !== undefined) {
    const length = changes.bio.trim().length;
    if (length < TASK_PROVIDER_LIMITS.bioMin || length > TASK_PROVIDER_LIMITS.bioMax)
      throw new TaskInputError("The bio must be 20 to 4000 characters.");
  }
  if (changes.displayName !== undefined) {
    const length = changes.displayName.trim().length;
    if (length < TASK_PROVIDER_LIMITS.nameMin || length > TASK_PROVIDER_LIMITS.nameMax)
      throw new TaskInputError("The name must be 2 to 80 characters.");
  }
  if (changes.location !== undefined) {
    const length = changes.location.trim().length;
    if (length < TASK_PROVIDER_LIMITS.locationMin || length > TASK_PROVIDER_LIMITS.locationMax)
      throw new TaskInputError("The location must be 2 to 80 characters.");
  }

  let photoFileId: string | undefined;
  if (photo) {
    const uploaded = await providerRequest("profile", "uploadFile", context, () =>
      context.client.uploadFile(photo),
    );
    photoFileId = uploaded.file.id;
  }

  let profile: ProviderProfileView;
  let action: "created" | "updated" = "updated";
  if (!existing) {
    profile = (
      await providerRequest("profile", "createProviderProfile", context, () =>
        requireTaskMethod(context.client, "createProviderProfile")(
          {
            displayName: changes.displayName!.trim(),
            bio: changes.bio!.trim(),
            skills: skills!,
            ...(photoFileId === undefined ? {} : { photoFileId }),
          },
          { idempotencyKey: context.randomUUID() },
        ),
      )
    ).vendorProfile;
    action = "created";
  } else profile = existing;

  const update: ProviderProfileUpdateInput = {
    ...(existing && changes.bio !== undefined ? { bio: changes.bio.trim() } : {}),
    ...(languages === undefined ? {} : { languages }),
    ...(changes.location === undefined ? {} : { location: changes.location.trim() }),
    ...(existing && photoFileId !== undefined ? { photoFileId } : {}),
    ...(changes.removePhoto ? { photoFileId: null } : {}),
  };
  if (Object.keys(update).length)
    profile = (
      await providerRequest("profile", "updateProviderProfile", context, () =>
        requireTaskMethod(context.client, "updateProviderProfile")(update, {
          idempotencyKey: context.randomUUID(),
        }),
      )
    ).vendorProfile;
  return {
    action,
    profile: publicProfile(profile),
    offers,
    verification: providerVerification(profile),
    ...(photoFileId === undefined ? {} : { photoFileId }),
    movesMoney: false,
  };
}

export type ProviderOfferChanges = {
  /** Service id; absent to publish a new service. */
  id?: string;
  title?: string;
  description?: string;
  packages?: readonly OfferPackage[];
  category?: string;
  skills?: readonly string[];
  paused?: boolean;
};

export type ProviderOfferOutcome =
  | { action: "list"; offers: OfferView[]; movesMoney: false }
  | { action: "created" | "updated"; offer: OfferView; movesMoney: false };

function checkOfferText(changes: ProviderOfferChanges) {
  const L = TASK_PROVIDER_LIMITS;
  if (changes.title !== undefined) {
    const length = changes.title.trim().length;
    if (length < L.offerTitleMin || length > L.offerTitleMax)
      throw new TaskInputError("The service title must be 3 to 120 characters.");
  }
  if (changes.description !== undefined) {
    const length = changes.description.trim().length;
    if (length < L.offerDescriptionMin || length > L.offerDescriptionMax)
      throw new TaskInputError("The service description must be 20 to 8000 characters.");
  }
  if (changes.packages !== undefined) {
    if (changes.packages.length < 1 || changes.packages.length > L.packagesMax)
      throw new TaskInputError("A service has one to three packages.");
    if (new Set(changes.packages.map((item) => item.tier)).size !== changes.packages.length)
      throw new TaskInputError("Each package tier can be used once.");
  }
}

/**
 * Lists, publishes or changes the acting wallet's services. Publishing and pausing
 * move no money; a buyer funds escrow only when they hire.
 */
export async function providerOfferTask(
  context: TaskOperationContext,
  changes: ProviderOfferChanges = {},
): Promise<ProviderOfferOutcome> {
  const { id, ...fields } = changes;
  const touched = Object.values(fields).some((value) => value !== undefined);
  if (id === undefined && !touched) {
    const read = await providerRequest("offer", "providerProfile", context, () =>
      requireTaskMethod(context.client, "providerProfile")(),
    );
    return { action: "list", offers: read.vendorProfile?.listings ?? [], movesMoney: false };
  }
  checkOfferText(changes);
  const category = changes.category === undefined ? undefined : offerCategory(changes.category);
  const skills = changes.skills === undefined ? undefined : offerSkills(changes.skills);
  const common = {
    ...(changes.title === undefined ? {} : { title: changes.title.trim() }),
    ...(changes.description === undefined ? {} : { description: changes.description.trim() }),
    ...(changes.packages === undefined ? {} : { packages: [...changes.packages] }),
    ...(category === undefined ? {} : { category }),
    ...(skills === undefined ? {} : { skills }),
    ...(changes.paused === undefined ? {} : { paused: changes.paused }),
  };
  if (id !== undefined) {
    if (!touched) throw new TaskInputError("Say what to change on the service.");
    const result = await providerRequest("offer", "updateOffer", context, () =>
      requireTaskMethod(context.client, "updateOffer")(id, common as OfferUpdateInput, {
        idempotencyKey: context.randomUUID(),
      }),
    );
    return { action: "updated", offer: result.listing, movesMoney: false };
  }
  if (changes.title === undefined || changes.description === undefined || !changes.packages)
    throw new TaskInputError(
      "A new service needs a title, a description and at least one package.",
    );
  const deployment = await taskRequest(
    "offer",
    "deployment",
    () => context.client.deployment(),
    context,
  );
  const result = await providerRequest("offer", "createOffer", context, () =>
    requireTaskMethod(context.client, "createOffer")(
      {
        ...common,
        title: changes.title!.trim(),
        description: changes.description!.trim(),
        packages: [...changes.packages!],
        category: category ?? "general_digital",
        network: deployment.network,
        // The website stores the settlement asset as "USDC"; hiring pays in USDC on this network.
        asset: "USDC",
      },
      { idempotencyKey: context.randomUUID() },
    ),
  );
  return { action: "created", offer: result.listing, movesMoney: false };
}
