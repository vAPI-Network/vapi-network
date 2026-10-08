import { createHash } from "node:crypto";

import { keccak256, toBytes } from "viem";
import { z } from "zod";

import { canonicalJson } from "./canonical-json.js";

const sha256Schema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/)
  .transform((digest) => digest.toLowerCase());

export const deliveryManifestSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            fileId: z.uuid(),
            fileName: z.string().min(1).max(255),
            sha256: sha256Schema,
            sizeBytes: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    noteSha256: sha256Schema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.files.map((file) => file.fileId)).size !== manifest.files.length) {
      context.addIssue({ code: "custom", path: ["files"], message: "File ids must be unique" });
    }
  });

export type DeliveryManifest = z.infer<typeof deliveryManifestSchema>;

export type FrozenDeliveryManifest = {
  manifest: DeliveryManifest;
  manifestHash: `0x${string}`;
};

export function freezeDeliveryManifest(input: unknown): FrozenDeliveryManifest {
  const parsed = deliveryManifestSchema.parse(input);
  const manifest = deliveryManifestSchema.parse({
    ...parsed,
    files: [...parsed.files].sort((left, right) => left.fileId.localeCompare(right.fileId)),
  });
  return {
    manifest,
    manifestHash: keccak256(toBytes(canonicalJson(manifest))),
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function prepareDeliveryManifest(
  files: Array<{ fileId: string; fileName: string; sha256: string; sizeBytes: number }>,
  note: string,
): Promise<FrozenDeliveryManifest> {
  if (files.length === 0) {
    throw new Error("Upload at least one delivery file.");
  }
  const noteSha256 = await sha256Hex(new TextEncoder().encode(note));
  return freezeDeliveryManifest({ files, noteSha256 });
}
