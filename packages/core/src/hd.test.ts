import { createHash } from "node:crypto";

import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/kit";
import { derivePath } from "ed25519-hd-key";
import { describe, expect, it } from "vitest";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

import {
  deriveEd25519Path,
  deriveEvmPrivateKey,
  deriveSolanaPrivateKey,
  entropyToPhrase,
  EVM_DERIVATION_PATH,
  generateRecoveryPhrase,
  phraseToEntropy,
  phraseToSeed,
  SOLANA_DERIVATION_PATH,
  validateRecoveryPhrase,
} from "./hd.js";
import { KeystoreError } from "./keystore.js";

/** The BIP-39 phrase every wallet's test suite derives its fixed vectors from. */
const TEST_PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
/** BIP-44 m/44'/60'/0'/0/0 for TEST_PHRASE, as MetaMask and Rabby show it. */
const TEST_PHRASE_EVM_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
/** SLIP-0010 m/44'/501'/0'/0' for TEST_PHRASE, as Phantom and Solflare show it. */
const TEST_PHRASE_SOLANA_ADDRESS = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";

const SLIP10_ED25519_VECTOR_1 = {
  seed: "000102030405060708090a0b0c0d0e0f",
  chains: [
    {
      path: "m",
      chainCode: "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb",
      privateKey: "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7",
    },
    {
      path: "m/0'",
      chainCode: "8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69",
      privateKey: "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3",
    },
    {
      path: "m/0'/1'",
      chainCode: "a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14",
      privateKey: "b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2",
    },
    {
      path: "m/0'/1'/2'",
      chainCode: "2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c",
      privateKey: "92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9",
    },
    {
      path: "m/0'/1'/2'/2'",
      chainCode: "8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc",
      privateKey: "30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662",
    },
    {
      path: "m/0'/1'/2'/2'/1000000000'",
      chainCode: "68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230",
      privateKey: "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793",
    },
  ],
} as const;

const SLIP10_ED25519_VECTOR_2 = {
  seed:
    "fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e" +
    "7b7875726f6c696663605d5a5754514e4b484542",
  chains: [
    {
      path: "m",
      chainCode: "ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b",
      privateKey: "171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012",
    },
    {
      path: "m/0'",
      chainCode: "0b78a3226f915c082bf118f83618a618ab6dec793752624cbeb622acb562862d",
      privateKey: "1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635",
    },
    {
      path: "m/0'/2147483647'",
      chainCode: "138f0b2551bcafeca6ff2aa88ba8ed0ed8de070841f0c4ef0165df8181eaad7f",
      privateKey: "ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4",
    },
    {
      path: "m/0'/2147483647'/1'",
      chainCode: "73bd9fff1cfbde33a1b846c27085f711c0fe2d66fd32e139d3ebc28e5a4a6b90",
      privateKey: "3757c7577170179c7868353ada796c839135b3d30554bbb74a4b1e4a5a58505c",
    },
    {
      path: "m/0'/2147483647'/1'/2147483646'",
      chainCode: "0902fe8a29f9140480a00ef244bd183e8a13288e4412d8389d140aac1794825a",
      privateKey: "5837736c89570de861ebc173b1086da4f505d4adb387c6a1b1342d5e4ac9ec72",
    },
    {
      path: "m/0'/2147483647'/1'/2147483646'/2'",
      chainCode: "5d70af781f3a37b829f0d060924d5e960bdc02e85423494afc0b1a41bbe196d4",
      privateKey: "551d333177df541ad876a60ea71f00447931c0a9da16f227c11ea080d7391b8d",
    },
  ],
} as const;

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** Varied but reproducible seed material: a failing case can be replayed. */
function pseudoRandomSeed(index: number): Uint8Array {
  const first = createHash("sha256").update(`vapi-slip10-${index}`).digest();
  const second = createHash("sha256").update(first).digest();
  return Uint8Array.from(Buffer.concat([first, second]));
}

describe("SLIP-0010 ed25519 derivation", () => {
  for (const vector of [SLIP10_ED25519_VECTOR_1, SLIP10_ED25519_VECTOR_2]) {
    for (const chain of vector.chains) {
      it(`matches the specification vector for ${chain.path} of ${vector.seed.slice(0, 8)}`, () => {
        const derived = deriveEd25519Path(
          Uint8Array.from(Buffer.from(vector.seed, "hex")),
          chain.path,
        );

        expect(hex(derived.privateKey)).toBe(chain.privateKey);
        expect(hex(derived.chainCode)).toBe(chain.chainCode);
      });
    }
  }

  it("agrees with ed25519-hd-key on the Solana path for twenty-five seeds", () => {
    for (let index = 0; index < 25; index += 1) {
      const seed = pseudoRandomSeed(index);
      const reference = derivePath(SOLANA_DERIVATION_PATH, hex(seed));

      expect(hex(deriveSolanaPrivateKey(seed))).toBe(hex(reference.key));
      expect(hex(deriveEd25519Path(seed, SOLANA_DERIVATION_PATH).chainCode)).toBe(
        hex(reference.chainCode),
      );
    }
  });

  it("refuses unhardened segments and malformed paths", () => {
    const seed = pseudoRandomSeed(0);

    expect(() => deriveSolanaPrivateKey(seed, "m/44'/501'/0'/0")).toThrow(KeystoreError);
    expect(() => deriveSolanaPrivateKey(seed, "44'/501'")).toThrow(/must start with m/);
    expect(() => deriveSolanaPrivateKey(seed, "m/2147483648'")).toThrow(KeystoreError);
  });
});

describe("recovery phrases", () => {
  it("generates a valid twelve-word English phrase", () => {
    const phrase = generateRecoveryPhrase();

    expect(phrase.split(" ")).toHaveLength(12);
    expect(validateRecoveryPhrase(phrase)).toBe(phrase);
    expect(phraseToEntropy(phrase)).toHaveLength(16);
    expect(entropyToPhrase(phraseToEntropy(phrase))).toBe(phrase);
  });

  it("normalises spacing and case before validating", () => {
    expect(validateRecoveryPhrase(`  ${TEST_PHRASE.toUpperCase().replace(/ /gu, "\n")}  `)).toBe(
      TEST_PHRASE,
    );
  });

  it("explains a wrong word count or a broken checksum without echoing the words", () => {
    const short = TEST_PHRASE.split(" ").slice(0, 11).join(" ");

    expect(() => validateRecoveryPhrase(short)).toThrow(KeystoreError);
    expect(() => validateRecoveryPhrase(short)).toThrow("12 or 24 words; this one has 11");
    expect(() => validateRecoveryPhrase(`${TEST_PHRASE.replace(/about$/u, "zoo")}`)).toThrow(
      "not valid",
    );
    try {
      validateRecoveryPhrase(short);
    } catch (error) {
      expect((error as Error).message).not.toContain("abandon");
    }
  });
});

describe("account derivation", () => {
  it("derives the published EVM address for the test phrase", () => {
    const seed = phraseToSeed(TEST_PHRASE);

    expect(privateKeyToAccount(deriveEvmPrivateKey(seed)).address).toBe(TEST_PHRASE_EVM_ADDRESS);
    expect(mnemonicToAccount(TEST_PHRASE).address).toBe(TEST_PHRASE_EVM_ADDRESS);
    expect(EVM_DERIVATION_PATH).toBe("m/44'/60'/0'/0/0");
  });

  it("agrees with viem's mnemonicToAccount for freshly generated phrases", () => {
    for (let index = 0; index < 5; index += 1) {
      const phrase = generateRecoveryPhrase();
      const derived = privateKeyToAccount(deriveEvmPrivateKey(phraseToSeed(phrase)));

      expect(derived.address).toBe(mnemonicToAccount(phrase).address);
    }
  });

  it("derives the Phantom address for the test phrase", async () => {
    const privateKey = deriveSolanaPrivateKey(phraseToSeed(TEST_PHRASE));
    // createKeyPairSignerFromPrivateKeyBytes zeroes the array it is handed.
    const signer = await createKeyPairSignerFromPrivateKeyBytes(Uint8Array.from(privateKey));

    expect(privateKey).toHaveLength(32);
    expect(signer.address).toBe(TEST_PHRASE_SOLANA_ADDRESS);
    expect(SOLANA_DERIVATION_PATH).toBe("m/44'/501'/0'/0'");
  });
});
