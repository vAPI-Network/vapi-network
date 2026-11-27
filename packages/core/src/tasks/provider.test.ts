import { describe, expect, it, vi } from "vitest";

import { missingTasksChain } from "./chain-port.js";
import { createTasksClient, TasksClientError } from "./client.js";
import { TaskInputError, type TaskOperationContext } from "./operation-support.js";
import {
  offerPackage,
  parseOfferDeliveryTime,
  parseOfferPackage,
  providerVerification,
  TASK_PROVIDER_VERIFICATION_CHECKS,
  type OfferPackage,
} from "./provider.js";
import { providerOfferTask, providerProfileTask } from "./provider-operations.js";

const KEY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROFILE_ID = "11111111-1111-4111-8111-111111111111";
const OFFER_ID = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "33333333-3333-4333-8333-333333333333";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const NOW = "2026-11-27T12:00:00.000Z";
const BASE = "https://tasks.example";

const pack: OfferPackage = {
  tier: "starter",
  summary: "One landing page with copy",
  priceBaseUnits: "150000000",
  deliveryTimeSeconds: 259_200,
  revisionCount: null,
  inclusions: ["One landing page with copy"],
};

const offer = {
  id: OFFER_ID,
  vendorProfileId: PROFILE_ID,
  title: "Landing pages",
  description: "I design and build landing pages that convert.",
  faq: [],
  tags: [],
  portfolio: [],
  category: "design_content",
  network: "eip155:8453",
  asset: "USDC",
  packages: [{ id: FILE_ID, ...pack }],
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function profile(status = "pending", extra: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    walletAddress: ADDRESS,
    displayName: "Ada",
    bio: "I build landing pages for small teams.",
    skills: ["web design"],
    languages: [],
    location: null,
    status,
    verified: status === "approved",
    approvedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    photoFileId: null,
    reputation: null,
    erc8004Registration: null,
    ...extra,
  };
}

const readyAvatar = {
  file: {
    id: FILE_ID,
    purpose: "avatar",
    fileName: "me.png",
    mimeType: "image/png",
    sizeBytes: 3,
    sha256: "ab".repeat(32),
    state: "ready",
    createdAt: NOW,
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordedFetch(...responses: Response[]) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(
      input instanceof Request && init === undefined ? input : new Request(input, init),
    );
    const response = responses.shift();
    if (!response) throw new Error("No canned response");
    return response;
  });
  return { fetch, requests };
}

function context(...responses: Response[]) {
  const recorder = recordedFetch(...responses);
  const client = createTasksClient({ baseUrl: BASE, token: "token-123", fetch: recorder.fetch });
  const value: TaskOperationContext = {
    client,
    chain: missingTasksChain,
    baseUrl: BASE,
    randomUUID: () => KEY,
    signInHint: "Run vapi login for the acting wallet.",
  };
  return { context: value, requests: recorder.requests };
}

async function summary(request: Request) {
  const text = await request.clone().text();
  return {
    method: request.method,
    url: request.url,
    key: request.headers.get("idempotency-key"),
    auth: request.headers.get("authorization"),
    body: request.headers.get("content-type") === "application/json" ? JSON.parse(text) : text,
  };
}

describe("provider client routes", () => {
  it("reads, creates and updates the provider profile and its services over HTTP", async () => {
    const recorder = recordedFetch(
      json({ vendorProfile: null }),
      json({ vendorProfile: profile() }),
      json({ vendorProfile: profile("pending", { location: "Lisbon" }) }),
      json({ listing: offer }),
      json({ listing: { ...offer, active: false } }),
    );
    const client = createTasksClient({ baseUrl: BASE, token: "token-123", fetch: recorder.fetch });

    await expect(client.providerProfile()).resolves.toEqual({ vendorProfile: null });
    await client.createProviderProfile(
      { displayName: "Ada", bio: "I build landing pages for small teams.", skills: ["web design"] },
      { idempotencyKey: KEY },
    );
    await client.updateProviderProfile({ location: "Lisbon" }, { idempotencyKey: KEY });
    await client.createOffer(
      {
        title: offer.title,
        description: offer.description,
        category: "design_content",
        network: "eip155:8453",
        asset: "USDC",
        packages: [pack],
      },
      { idempotencyKey: KEY },
    );
    await client.updateOffer(OFFER_ID, { paused: true }, { idempotencyKey: KEY });

    const sent = await Promise.all(recorder.requests.map(summary));
    expect(sent.map(({ method, url, key }) => [method, url, key])).toEqual([
      ["GET", `${BASE}/v1/vendor-profile`, null],
      ["POST", `${BASE}/v1/vendor-profile`, KEY],
      ["PATCH", `${BASE}/v1/vendor-profile`, KEY],
      ["POST", `${BASE}/v1/listings`, KEY],
      ["PATCH", `${BASE}/v1/listings/${OFFER_ID}`, KEY],
    ]);
    expect(sent.every(({ auth }) => auth === "Bearer token-123")).toBe(true);
    expect(sent[4]!.body).toEqual({ paused: true });
  });

  it("rejects malformed provider input before any request", async () => {
    const recorder = recordedFetch();
    const client = createTasksClient({ baseUrl: BASE, fetch: recorder.fetch });
    expect(() =>
      client.updateProviderProfile(
        { languages: ["Klingon" as "English"] },
        { idempotencyKey: KEY },
      ),
    ).toThrowError(TasksClientError);
    expect(() => client.updateProviderProfile({}, { idempotencyKey: KEY })).toThrowError(
      /At least one profile field/u,
    );
    expect(() =>
      client.updateOffer(OFFER_ID, { title: "x" }, { idempotencyKey: KEY }),
    ).toThrowError(TasksClientError);
    expect(recorder.fetch).not.toHaveBeenCalled();
  });
});

describe("provider packages", () => {
  it("parses tier, price, delivery time and a summary that may contain colons", () => {
    expect(parseOfferPackage("standard:250.5:48h:Two pages: home and pricing")).toEqual({
      tier: "standard",
      summary: "Two pages: home and pricing",
      priceBaseUnits: "250500000",
      deliveryTimeSeconds: 172_800,
      revisionCount: null,
      inclusions: ["Two pages: home and pricing"],
    });
    expect(parseOfferDeliveryTime("90m")).toBe(5_400);
    expect(parseOfferDeliveryTime("90d")).toBe(7_776_000);
  });

  it.each([
    "starter:150:3d",
    "premium:150:3d:One landing page",
    "starter:0:3d:One landing page",
    "starter:1.0000001:3d:One landing page",
    "starter:150:30m:One landing page",
    "starter:150:91d:One landing page",
    "starter:150:2026-12-01T00:00:00Z:One landing page",
    "starter:150:3d:short",
  ])("refuses %s", (spec) => {
    expect(() => parseOfferPackage(spec)).toThrowError(TaskInputError);
  });

  it("caps the summary at the inclusion limit", () => {
    expect(() =>
      offerPackage({
        tier: "starter",
        priceUsd: "1",
        deliveryTime: "1d",
        summary: "x".repeat(161),
      }),
    ).toThrowError(/10 to 160/u);
  });
});

describe("provider verification", () => {
  it("maps the profile status to the three checks the website shows", () => {
    expect(TASK_PROVIDER_VERIFICATION_CHECKS.map(({ title }) => title)).toEqual([
      "vAPI ID",
      "A work link",
      "One social account",
    ]);
    expect(providerVerification(null).status).toBe("no-profile");
    expect(providerVerification({ status: "pending" })).toMatchObject({
      status: "not-verified",
      verified: false,
    });
    expect(providerVerification({ status: "approved" })).toMatchObject({
      status: "verified",
      verified: true,
    });
    expect(providerVerification({ status: "rejected" }).status).toBe("taken-down");
  });
});

describe("providerProfileTask", () => {
  it("only reads when there is nothing to change", async () => {
    const { context: ctx, requests } = context(
      json({ vendorProfile: { ...profile(), listings: [offer] } }),
    );
    const outcome = await providerProfileTask(ctx);
    expect(outcome).toMatchObject({
      action: "read",
      profile: { id: PROFILE_ID, displayName: "Ada" },
      offers: [{ id: OFFER_ID }],
      verification: { status: "not-verified" },
      movesMoney: false,
    });
    expect(outcome.profile).not.toHaveProperty("listings");
    expect(requests).toHaveLength(1);
  });

  it("uploads the photo as an avatar, creates the profile, then sets languages and location", async () => {
    const { context: ctx, requests } = context(
      json({ vendorProfile: null }),
      json({
        file: { ...readyAvatar.file, state: "pending", sha256: null },
        uploadUrl: "https://storage.example/put",
      }),
      new Response(null, { status: 200 }),
      json(readyAvatar),
      json({ vendorProfile: profile("pending", { photoFileId: FILE_ID }) }),
      json({
        vendorProfile: profile("pending", {
          photoFileId: FILE_ID,
          languages: ["English"],
          location: "Lisbon",
        }),
      }),
    );
    const outcome = await providerProfileTask(ctx, {
      displayName: " Ada ",
      bio: "I build landing pages for small teams.",
      skills: ["Web design", "web DESIGN", "Copy"],
      languages: ["english"],
      location: "Lisbon",
      photo: { fileName: "me.png", bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" },
    });
    expect(outcome).toMatchObject({ action: "created", photoFileId: FILE_ID });
    const sent = await Promise.all(requests.map(summary));
    expect(sent.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET ${BASE}/v1/vendor-profile`,
      `POST ${BASE}/v1/files`,
      "PUT https://storage.example/put",
      `POST ${BASE}/v1/files/${FILE_ID}/finalize`,
      `POST ${BASE}/v1/vendor-profile`,
      `PATCH ${BASE}/v1/vendor-profile`,
    ]);
    expect(sent[1]!.body).toEqual({
      purpose: "avatar",
      fileName: "me.png",
      mimeType: "image/png",
      sizeBytes: 3,
    });
    expect(sent[2]!.auth).toBeNull();
    expect(sent[4]!.body).toEqual({
      displayName: "Ada",
      bio: "I build landing pages for small teams.",
      skills: ["Web design", "Copy"],
      photoFileId: FILE_ID,
    });
    expect(sent[5]!.body).toEqual({ languages: ["English"], location: "Lisbon" });
  });

  it("removes the photo of a live profile and refuses name or skill changes", async () => {
    const live = { ...profile("approved"), listings: [] };
    const { context: ctx, requests } = context(
      json({ vendorProfile: live }),
      json({ vendorProfile: profile("approved") }),
    );
    await expect(providerProfileTask(ctx, { removePhoto: true })).resolves.toMatchObject({
      action: "updated",
      verification: { status: "verified" },
    });
    expect(await summary(requests[1]!)).toMatchObject({
      method: "PATCH",
      body: { photoFileId: null },
    });

    const second = context(json({ vendorProfile: live }));
    await expect(providerProfileTask(second.context, { displayName: "Other" })).rejects.toThrow(
      /name or skills/u,
    );
    expect(second.requests).toHaveLength(1);
  });

  it("refuses a new profile without name, bio and skill, and a bad photo before upload", async () => {
    const { context: ctx, requests } = context(json({ vendorProfile: null }));
    await expect(providerProfileTask(ctx, { bio: "I build landing pages." })).rejects.toThrow(
      /name, a bio and at least one skill/u,
    );
    expect(requests).toHaveLength(1);
    await expect(
      providerProfileTask(ctx, {
        photo: { fileName: "me.gif", bytes: new Uint8Array([1]), contentType: "image/gif" },
      }),
    ).rejects.toThrow(/PNG, JPEG or WebP/u);
    expect(requests).toHaveLength(1);
  });

  it("explains a missing provider profile instead of asking for sign-in", async () => {
    const { context: ctx } = context(
      json({ error: { code: "approved_vendor_required", message: "x" } }, 403),
    );
    await expect(providerOfferTask(ctx, { id: OFFER_ID, paused: true })).rejects.toMatchObject({
      code: "approved_vendor_required",
      message: expect.stringContaining("no live provider profile"),
    });
  });

  it("tells a linked agent that the owner manages the provider profile", async () => {
    const { context: ctx } = context(
      json({ error: { code: "provider_owner_wallet_required", message: "x" } }, 403),
    );
    await expect(providerOfferTask(ctx, { id: OFFER_ID, paused: true })).rejects.toMatchObject({
      code: "provider_owner_wallet_required",
      message: expect.stringContaining("Linked agents cannot manage"),
    });
  });
});

describe("providerOfferTask", () => {
  it("lists the acting wallet's services", async () => {
    const { context: ctx } = context(json({ vendorProfile: { ...profile(), listings: [offer] } }));
    await expect(providerOfferTask(ctx)).resolves.toEqual({
      action: "list",
      offers: [offer],
      movesMoney: false,
    });
  });

  it("publishes on the network vAPI reports, with the website's asset and default category", async () => {
    const { context: ctx, requests } = context(
      json({
        configured: false,
        chainId: 8453,
        network: "eip155:8453",
        explorerUrl: null,
        capabilities: { erc3009Funding: false, vapiVerify: false },
        eip3009Domain: null,
      }),
      json({ listing: offer }),
    );
    const outcome = await providerOfferTask(ctx, {
      title: "Landing pages",
      description: "I design and build landing pages that convert.",
      packages: [parseOfferPackage("starter:150:3d:One landing page with copy")],
      skills: ["Web-Design"],
    });
    expect(outcome).toMatchObject({ action: "created", offer: { id: OFFER_ID } });
    expect(await summary(requests[1]!)).toMatchObject({
      method: "POST",
      url: `${BASE}/v1/listings`,
      key: KEY,
      body: {
        title: "Landing pages",
        description: "I design and build landing pages that convert.",
        packages: [pack],
        category: "general_digital",
        network: "eip155:8453",
        asset: "USDC",
        skills: ["web-design"],
      },
    });
  });

  it("changes only the given fields of a service", async () => {
    const { context: ctx, requests } = context(json({ listing: offer }));
    await providerOfferTask(ctx, { id: OFFER_ID, category: "software-api", paused: false });
    expect(await summary(requests[0]!)).toMatchObject({
      method: "PATCH",
      url: `${BASE}/v1/listings/${OFFER_ID}`,
      body: { category: "software_api", paused: false },
    });
  });

  it.each([
    [{ title: "Landing pages" }, /title, a description and at least one package/u],
    [{ id: OFFER_ID, category: "art" }, /Category must be/u],
    [{ id: OFFER_ID, skills: ["not a tag"] }, /lowercase letters/u],
    [
      {
        title: "Landing pages",
        description: "I design and build landing pages that convert.",
        packages: [pack, pack],
      },
      /tier can be used once/u,
    ],
  ])("refuses %j before any request", async (changes, message) => {
    const { context: ctx, requests } = context();
    await expect(providerOfferTask(ctx, changes)).rejects.toThrow(message);
    expect(requests).toHaveLength(0);
  });
});
