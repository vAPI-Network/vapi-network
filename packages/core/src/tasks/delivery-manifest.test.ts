import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import {
  deliveryManifestSchema,
  freezeDeliveryManifest,
  prepareDeliveryManifest,
  sha256Hex,
  type DeliveryManifest,
} from "./delivery-manifest.js";

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "00000000-0000-4000-8000-000000000002";
const DIGEST = "A".repeat(64);

function file(overrides: Record<string, unknown> = {}) {
  return {
    fileId: ID_A,
    fileName: "result.txt",
    sha256: DIGEST,
    sizeBytes: 1,
    ...overrides,
  };
}

describe("delivery manifest schema", () => {
  it("accepts boundary values and normalizes uppercase hashes", () => {
    const files = Array.from({ length: 20 }, (_, index) =>
      file({
        fileId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        fileName: "x".repeat(255),
      }),
    );

    const parsed = deliveryManifestSchema.parse({ files, noteSha256: DIGEST });

    expect(parsed.files).toHaveLength(20);
    expect(parsed.files[0]?.sha256).toBe("a".repeat(64));
    expect(parsed.noteSha256).toBe("a".repeat(64));
  });

  it.each([
    { files: [], noteSha256: DIGEST },
    {
      files: Array.from({ length: 21 }, (_, index) =>
        file({ fileId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }),
      ),
      noteSha256: DIGEST,
    },
    { files: [file({ fileId: "not-a-uuid" })], noteSha256: DIGEST },
    { files: [file({ fileId: "00000000-0000-f000-8000-000000000001" })], noteSha256: DIGEST },
    { files: [file({ fileId: "00000000-0000-4000-7000-000000000001" })], noteSha256: DIGEST },
    { files: [file(), file()], noteSha256: DIGEST },
    { files: [file({ fileName: "" })], noteSha256: DIGEST },
    { files: [file({ fileName: "x".repeat(256) })], noteSha256: DIGEST },
    { files: [file({ sha256: "bad" })], noteSha256: DIGEST },
    { files: [file({ sha256: "g".repeat(64) })], noteSha256: DIGEST },
    { files: [file()], noteSha256: "bad" },
    { files: [file({ sizeBytes: 0 })], noteSha256: DIGEST },
    { files: [file({ sizeBytes: -1 })], noteSha256: DIGEST },
    { files: [file({ sizeBytes: 1.5 })], noteSha256: DIGEST },
    { files: [file({ extra: true })], noteSha256: DIGEST },
    { files: [file()], noteSha256: DIGEST, extra: true },
  ])("rejects an invalid manifest", (manifest) => {
    expect(() => deliveryManifestSchema.parse(manifest)).toThrow();
  });
});

describe("freezeDeliveryManifest", () => {
  it("sorts files without mutating the input and produces a stable hash", () => {
    const input = {
      files: [file({ fileId: ID_B }), file({ fileId: ID_A })],
      noteSha256: "b".repeat(64),
    };
    const originalOrder = input.files.map(({ fileId }) => fileId);

    const frozen = freezeDeliveryManifest(input);

    expect(frozen.manifest.files.map(({ fileId }) => fileId)).toEqual([ID_A, ID_B]);
    expect(input.files.map(({ fileId }) => fileId)).toEqual(originalOrder);
    expect(frozen.manifestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(freezeDeliveryManifest(input).manifestHash).toBe(frozen.manifestHash);
  });

  it("uses localeCompare rather than code-point order for file ids", () => {
    const lowercaseFirst = "a0000000-0000-4000-8000-000000000001";
    const uppercaseSecond = "B0000000-0000-4000-8000-000000000001";

    const frozen = freezeDeliveryManifest({
      files: [file({ fileId: uppercaseSecond }), file({ fileId: lowercaseFirst })],
      noteSha256: "b".repeat(64),
    });

    expect(frozen.manifest.files.map(({ fileId }) => fileId)).toEqual([
      lowercaseFirst,
      uppercaseSecond,
    ]);
  });
});

describe("prepareDeliveryManifest", () => {
  it("hashes UTF-8 notes and validates files", async () => {
    const result = await prepareDeliveryManifest([file()], "hello");

    expect(result.manifest.noteSha256).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(result.manifest.files[0]?.sha256).toBe("a".repeat(64));
  });

  it("rejects an empty file list with the product error", async () => {
    await expect(prepareDeliveryManifest([], "note")).rejects.toThrow(
      "Upload at least one delivery file.",
    );
  });

  it("rejects extra file fields", async () => {
    await expect(prepareDeliveryManifest([file({ extra: true })], "note")).rejects.toThrow();
  });
});

describe("sha256Hex", () => {
  it("matches the known SHA-256 vector for abc", async () => {
    await expect(sha256Hex(new TextEncoder().encode("abc"))).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("shared fixture", () => {
  it("matches the console manifest algorithm", async () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../test/fixtures/delivery-manifest.json", import.meta.url), "utf8"),
    ) as {
      files: Parameters<typeof prepareDeliveryManifest>[0];
      note: string;
      expected: {
        manifest: DeliveryManifest;
        canonicalJson: string;
        manifestHash: `0x${string}`;
      };
    };

    const prepared = await prepareDeliveryManifest(fixture.files, fixture.note);

    expect(prepared.manifest).toEqual(fixture.expected.manifest);
    expect(canonicalJson(prepared.manifest)).toBe(fixture.expected.canonicalJson);
    expect(prepared.manifestHash).toBe(fixture.expected.manifestHash);
  });
});
