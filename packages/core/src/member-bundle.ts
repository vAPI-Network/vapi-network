import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { agentSecretAccounts } from "./agent-link.js";
import { agentProfileSchema, type AgentGrant, type AgentProfile } from "./agent-profile.js";
import { RUN_ID_PATTERN } from "./agent-run.js";
import { configSchema, DEFAULT_SPEND_CAPS, spendCapsSchema, type VapiConfig } from "./config.js";
import { NETWORKS } from "./networks.js";
import type { SecretStore } from "./secret-store.js";
import { SWARM_NAME_PATTERN } from "./swarm.js";
import type { AgentLink } from "./wallet-store.js";
import { isWalletName, walletNameSchema, type WalletName } from "./wallet-name.js";

/**
 * A member bundle: everything one swarm member needs to run on a remote
 * sandbox, as one base64url string.
 *
 * It carries exactly one account's own private key and that account's own link
 * credentials. It never carries the vault recovery phrase, the device vault
 * key, an owner refresh token, another account's key or tokens, or the registry
 * API key. Remote members never hold the `delegate` or `allocate` grant, so a
 * bundle cannot either.
 *
 * This module is exported only from `@vapi-network/core/secrets`.
 */

/** The largest encoded bundle accepted or produced, in bytes of base64url text. */
export const MEMBER_BUNDLE_MAX_BYTES = 32 * 1024;

/** The grants a member running on a remote sandbox never holds. */
const REMOTE_BLOCKED_GRANTS: ReadonlySet<AgentGrant> = new Set<AgentGrant>([
  "delegate",
  "allocate",
]);

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ATOMIC_PATTERN = /^\d+$/;

/**
 * The only network settings a member bundle carries: the swarm's one network
 * and its USDC token. Never an RPC URL: the owner's often embed a provider API
 * key, so a headless run uses the network's public default. This limits client
 * configuration, not the EVM key's authority on other chains.
 */
export type MemberBundleConfig = {
  discoveryUrl: string;
  marketplaceDiscoveryUrl: string;
  networks: Partial<Record<MemberBundleNetwork, { usdc: string }>>;
};

/** A network a member can run on: one whose definition has a public RPC default. */
export type MemberBundleNetwork = {
  [Id in keyof typeof NETWORKS]: (typeof NETWORKS)[Id] extends { publicRpcUrl: string }
    ? Id
    : never;
}[keyof typeof NETWORKS];

/** Keys that never belong anywhere inside a bundle's config. */
const FORBIDDEN_CONFIG_KEYS: ReadonlySet<string> = new Set(["rpcUrl", "apiKey"]);

export type MemberCredentials = {
  /** One short-lived access token marked non-refreshable, as serialized JSON. */
  tokens: string;
  /** The account's Router stake key, when it has one. */
  routerStake?: string;
  /** The account's Router balance key, when it has one. */
  routerBalance?: string;
};

export type MemberBundle = {
  v: 1;
  account: WalletName;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  swarm: string;
  profile: AgentProfile;
  link: AgentLink;
  credentials: MemberCredentials;
  caps: { perCallAtomic: string; perDayAtomic: string };
  /** End of the UTC day whose local spend allowance funded this remote run. */
  allowanceExpiresAt: string;
  ceilingAtomic: string;
  config: MemberBundleConfig;
  runId: string;
  parentRunId?: string;
};

export type MemberBundleErrorCode =
  "invalid" | "too_large" | "key_mismatch" | "not_linked" | "unsafe_config" | "unsupported_network";

/** Every refusal of this module. Messages never contain bundle text or a key. */
export class MemberBundleError extends Error {
  constructor(
    readonly code: MemberBundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MemberBundleError";
  }
}

const hexString = (pattern: RegExp, message: string) =>
  z.custom<`0x${string}`>((value) => typeof value === "string" && pattern.test(value), message);

const linkSchema: z.ZodType<AgentLink> = z.strictObject({
  apiBase: z.string(),
  clientId: z.string(),
  owner: z.custom<`0x${string}`>((value) => typeof value === "string" && value.startsWith("0x")),
  label: z.string(),
  scopes: z.array(z.string()),
  linkedAt: z.iso.datetime(),
  routerBaseUrl: z.string().optional(),
});

const remoteTokensSchema = z.strictObject({
  accessToken: z.string().min(1),
  expiresAt: z.number().finite(),
  scopes: z.array(z.string()),
  refreshable: z.literal(false),
});

const storedTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  scopes: z.array(z.string()),
});

const credentialsSchema: z.ZodType<MemberCredentials> = z.strictObject({
  tokens: z
    .string()
    .min(1)
    .refine(isRemoteTokens, "A member bundle carries a non-refreshable access token only."),
  routerStake: z.string().min(1).optional(),
  routerBalance: z.string().min(1).optional(),
});

const remoteProfileSchema = agentProfileSchema
  .strict()
  .refine((profile) => profile.grants.every((grant) => !REMOTE_BLOCKED_GRANTS.has(grant)), {
    message: "A remote member never holds the delegate or allocate grant.",
    path: ["grants"],
  });

/** A URL that can carry no credential: no user name, password, query string or fragment. */
const credentialFreeUrl = z.url().refine((value) => unsafeUrlPart(value) === undefined, {
  message: "A member bundle URL never carries a user name, password, query or fragment.",
});

/**
 * The bundle's config: enabled network ids and USDC only. Strict objects refuse
 * every other key; the explicit check names why `rpcUrl` and `apiKey` in
 * particular never belong in a bundle, at any depth.
 */
export const memberBundleConfigSchema: z.ZodType<MemberBundleConfig> = z
  .unknown()
  .refine((value) => !hasForbiddenConfigKey(value), {
    message: "A member bundle never carries RPC URLs or API keys.",
  })
  .pipe(
    z.strictObject({
      discoveryUrl: credentialFreeUrl,
      marketplaceDiscoveryUrl: credentialFreeUrl,
      networks: z
        .record(
          z.string().refine(isMemberBundleNetwork, {
            message: "Expected a network with a public RPC default.",
          }),
          z.strictObject({ usdc: z.string() }),
        )
        .refine(
          (networks) =>
            Object.entries(networks).every(
              ([id, network]) => isMemberBundleNetwork(id) && network.usdc === NETWORKS[id].usdc,
            ),
          { message: "Expected the canonical USDC token of each network." },
        )
        .refine((networks) => Object.keys(networks).length === 1, {
          message: "A member bundle carries exactly one network: the swarm's.",
        }),
    }),
  ) as z.ZodType<MemberBundleConfig>;

export const memberBundleSchema: z.ZodType<MemberBundle> = z.strictObject({
  v: z.literal(1),
  account: walletNameSchema,
  address: hexString(ADDRESS_PATTERN, "Expected a 20-byte 0x address."),
  privateKey: hexString(PRIVATE_KEY_PATTERN, "Expected a 32-byte 0x private key."),
  swarm: z.string().regex(SWARM_NAME_PATTERN),
  profile: remoteProfileSchema,
  link: linkSchema,
  credentials: credentialsSchema,
  caps: z.strictObject(spendCapsSchema.shape),
  allowanceExpiresAt: z.iso.datetime(),
  ceilingAtomic: z.string().regex(ATOMIC_PATTERN, "Expected non-negative atomic units."),
  config: memberBundleConfigSchema,
  runId: z.string().regex(RUN_ID_PATTERN),
  parentRunId: z.string().regex(RUN_ID_PATTERN).optional(),
});

/**
 * The part of the owner's config a member bundle may carry: the swarm's
 * network, with USDC from the network definition, and the two discovery URLs.
 * The owner's RPC URLs, API key, other enabled networks and everything else
 * stay on this machine. The exported key still controls the same EVM address
 * on every chain. A swarm network that is not enabled here or has no public
 * RPC default is refused, as is a discovery URL that could carry a credential.
 */
export function memberBundleConfig(owner: VapiConfig, network: string): MemberBundleConfig {
  const discoveryUrl = safeDiscoveryUrl("discoveryUrl", owner.discoveryUrl);
  const marketplaceDiscoveryUrl = safeDiscoveryUrl(
    "marketplaceDiscoveryUrl",
    owner.marketplaceDiscoveryUrl,
  );
  if (!Object.hasOwn(owner.networks, network) || !isMemberBundleNetwork(network)) {
    throw new MemberBundleError(
      "unsupported_network",
      `A member bundle runs on the swarm network ${network}, which must be enabled in this config and have a public RPC default.`,
    );
  }
  return {
    discoveryUrl,
    marketplaceDiscoveryUrl,
    networks: { [network]: { usdc: NETWORKS[network].usdc } },
  };
}

/**
 * The config a headless run writes to its ephemeral home: the bundle's
 * networks on their public RPC defaults, and the default spend caps as the
 * fallback (the member's own caps live on its wallet entry). An RPC variable
 * such as `BASE_RPC_URL` set inside the sandbox still overrides the default.
 */
export function headlessConfigFromBundle(config: MemberBundleConfig): VapiConfig {
  const networks: Record<string, { rpcUrl: string; usdc: string }> = {};
  for (const [id, network] of Object.entries(config.networks)) {
    if (!isMemberBundleNetwork(id) || network === undefined) continue;
    networks[id] = { rpcUrl: NETWORKS[id].publicRpcUrl, usdc: network.usdc };
  }
  return configSchema.parse({
    discoveryUrl: config.discoveryUrl,
    marketplaceDiscoveryUrl: config.marketplaceDiscoveryUrl,
    networks,
    spendCaps: { ...DEFAULT_SPEND_CAPS },
  });
}

/** Validates, serializes and encodes one member's bundle. */
export function createMemberBundle(input: Omit<MemberBundle, "v">): string {
  const bundle = parseBundle({ ...input, profile: withoutRemoteGrants(input.profile), v: 1 });
  assertKeyMatchesAddress(bundle);
  const encoded = Buffer.from(JSON.stringify(bundle), "utf8").toString("base64url");
  if (encoded.length > MEMBER_BUNDLE_MAX_BYTES) {
    throw new MemberBundleError(
      "too_large",
      `The member bundle is larger than ${MEMBER_BUNDLE_MAX_BYTES} bytes.`,
    );
  }
  return encoded;
}

/** Decodes and strictly validates a bundle made by `createMemberBundle`. */
export function openMemberBundle(text: string): MemberBundle {
  if (typeof text !== "string") {
    throw new MemberBundleError("invalid", "The member bundle is not a string.");
  }
  if (text.length > MEMBER_BUNDLE_MAX_BYTES) {
    throw new MemberBundleError(
      "too_large",
      `The member bundle is larger than ${MEMBER_BUNDLE_MAX_BYTES} bytes.`,
    );
  }
  if (!BASE64URL_PATTERN.test(text)) {
    throw new MemberBundleError("invalid", "The member bundle is not base64url text.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw new MemberBundleError("invalid", "The member bundle does not decode to JSON.");
  }
  const bundle = parseBundle(decoded);
  assertKeyMatchesAddress(bundle);
  return bundle;
}

/**
 * The link credentials of one account, and only that account: the three
 * secret-store names `agentSecretAccounts(account)` gives, nothing else.
 */
export async function readMemberCredentials(args: {
  secrets: SecretStore;
  account: WalletName;
}): Promise<MemberCredentials> {
  if (!isWalletName(args.account)) {
    throw new MemberBundleError("invalid", "The member account name is not valid.");
  }
  const names = agentSecretAccounts(args.account);
  const storedTokens = await args.secrets.get(names.tokens);
  if (storedTokens === undefined || storedTokens === "") {
    throw new MemberBundleError(
      "not_linked",
      `The account ${args.account} is not linked to vAPI. Link it with vapi login first.`,
    );
  }
  const routerStake = await args.secrets.get(names.routerStake);
  const routerBalance = await args.secrets.get(names.routerBalance);
  const parsed = parseStoredTokens(storedTokens);
  if (parsed === undefined) {
    throw new MemberBundleError(
      "not_linked",
      `The account ${args.account}'s vAPI credentials cannot be exported safely. Run vapi login --account ${args.account} again.`,
    );
  }
  const tokens = JSON.stringify({
    accessToken: parsed.accessToken,
    expiresAt: parsed.expiresAt,
    scopes: parsed.scopes,
    refreshable: false,
  });
  return {
    tokens,
    ...(routerStake === undefined || routerStake === "" ? {} : { routerStake }),
    ...(routerBalance === undefined || routerBalance === "" ? {} : { routerBalance }),
  };
}

function isRemoteTokens(value: string): boolean {
  try {
    return remoteTokensSchema.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

function parseStoredTokens(value: string): z.infer<typeof storedTokensSchema> | undefined {
  try {
    const parsed = storedTokensSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isMemberBundleNetwork(id: string): id is MemberBundleNetwork {
  return (
    Object.hasOwn(NETWORKS, id) &&
    typeof (NETWORKS[id as keyof typeof NETWORKS] as { publicRpcUrl?: string }).publicRpcUrl ===
      "string"
  );
}

function hasForbiddenConfigKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenConfigKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) => FORBIDDEN_CONFIG_KEYS.has(key) || hasForbiddenConfigKey(item),
  );
}

/** Which credential-bearing part a URL has, if any. Never returns the value itself. */
function unsafeUrlPart(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "an unparseable value";
  }
  if (url.username !== "" || url.password !== "") return "a user name or password";
  // `search`/`hash` are empty for a bare "?" or "#", so look at the text too.
  if (url.search !== "" || value.includes("?")) return "a query string";
  if (url.hash !== "" || value.includes("#")) return "a fragment";
  return undefined;
}

function safeDiscoveryUrl(field: string, value: string): string {
  const part = unsafeUrlPart(value);
  if (part !== undefined) {
    throw new MemberBundleError(
      "unsafe_config",
      `The owner config's ${field} has ${part}, which can carry a credential, so it never goes into a member bundle. Point ${field} at a plain URL (check VAPI_DISCOVERY_URL, VAPI_MARKETPLACE_DISCOVERY_URL and config.json).`,
    );
  }
  return value;
}

function withoutRemoteGrants(profile: AgentProfile): AgentProfile {
  if (typeof profile !== "object" || profile === null || !Array.isArray(profile.grants)) {
    return profile;
  }
  return {
    ...profile,
    grants: profile.grants.filter((grant) => !REMOTE_BLOCKED_GRANTS.has(grant)),
  };
}

function parseBundle(value: unknown): MemberBundle {
  const parsed = memberBundleSchema.safeParse(value);
  if (!parsed.success) {
    // Only field paths: never an issue message or input that could echo a value.
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)")),
    ];
    throw new MemberBundleError(
      "invalid",
      `The member bundle is not valid (fields: ${fields.join(", ")}).`,
    );
  }
  return parsed.data;
}

function assertKeyMatchesAddress(bundle: MemberBundle): void {
  let derived: string;
  try {
    derived = privateKeyToAccount(bundle.privateKey).address;
  } catch {
    throw new MemberBundleError("key_mismatch", "The member bundle's key is not a valid key.");
  }
  if (derived.toLowerCase() !== bundle.address.toLowerCase()) {
    throw new MemberBundleError(
      "key_mismatch",
      "The member bundle's key does not match its address.",
    );
  }
}
