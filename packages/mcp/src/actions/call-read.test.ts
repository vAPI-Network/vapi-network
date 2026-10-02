import { beforeEach, describe, expect, it, vi } from "vitest";
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const mocks = vi.hoisted(() => ({ completeX402Payment: vi.fn() }));

vi.mock("@vapi-network/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@vapi-network/core")>();
  return { ...actual, completeX402Payment: mocks.completeX402Payment };
});

import { BASE_MAINNET_CAIP2, getDefaultConfig } from "@vapi-network/core";

import { callRead, readPaidOrigin } from "./call-read.js";
import type { ActionContext } from "./context.js";
import { runAction } from "./register.js";

const PRIVATE_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as Hex;
const RESOURCE_URL = "https://93.184.216.34/private";
const RESOURCE_ORIGIN = "https://93.184.216.34";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("call.read", () => {
  it("refuses an HTTP URL before fetching", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      readPaidOrigin({
        ...readerArgs(fetchImpl),
        url: "http://93.184.216.34/private",
        paidOrigins: new Set(["http://93.184.216.34"]),
      }),
    ).rejects.toThrow("call.read only reads HTTPS URLs");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses an origin that was not paid in this run", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      readPaidOrigin({
        ...readerArgs(fetchImpl),
        paidOrigins: new Set(["https://93.184.216.35"]),
      }),
    ).rejects.toThrow("call.read only reads origins this agent paid in this run");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads JSON from a paid origin with a bodyless manual GET", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ private: true }, { status: 200 }));

    await expect(readPaidOrigin(readerArgs(fetchImpl))).resolves.toEqual({
      status: 200,
      contentType: "application/json",
      body: { private: true },
    });
    const request = fetchImpl.mock.calls[0]?.[0] as Request;
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(request.redirect).toBe("manual");
  });

  it("refuses a redirect to an unpaid origin", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://93.184.216.35/private" },
      }),
    );

    await expect(readPaidOrigin(readerArgs(fetchImpl))).rejects.toThrow(
      "call.read never leaves its initial paid origin",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not forward a SIWX proof to another paid origin", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(signInRequired(), { status: 402 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://93.184.216.35/private" },
        }),
      );

    await expect(
      readPaidOrigin({
        ...readerArgs(fetchImpl),
        paidOrigins: new Set([RESOURCE_ORIGIN, "https://93.184.216.35"]),
      }),
    ).rejects.toThrow("call.read never leaves its initial paid origin");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1]?.[0] as Request).headers.has("sign-in-with-x")).toBe(true);
  });

  it("refuses a redirect to HTTP", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://93.184.216.34/private" },
      }),
    );

    await expect(readPaidOrigin(readerArgs(fetchImpl))).rejects.toThrow(
      "call.read only reads HTTPS URLs",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("follows at most three redirects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      const hop = Number(path.slice(1));
      return new Response(null, { status: 302, headers: { location: `/${hop + 1}` } });
    });

    await expect(
      readPaidOrigin({ ...readerArgs(fetchImpl), url: `${RESOURCE_ORIGIN}/0` }),
    ).rejects.toThrow("call.read exceeded the maximum of 3 HTTP redirect hops");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("signs an origin-bound SIWX proof and retries once", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(signInRequired(), { status: 402 }))
      .mockResolvedValueOnce(Response.json({ private: true }, { status: 200 }));

    await expect(readPaidOrigin({ ...readerArgs(fetchImpl), account })).resolves.toEqual({
      status: 200,
      contentType: "application/json",
      body: { private: true },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const signedRequest = fetchImpl.mock.calls[1]?.[0] as Request;
    const encoded = signedRequest.headers.get("sign-in-with-x");
    expect(encoded).not.toBeNull();
    const proof = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(proof).toMatchObject({
      address: account.address,
      domain: "93.184.216.34",
      uri: RESOURCE_URL,
    });
  });

  it.each([200, 500])(
    "redacts a reflected SIWX proof from a signed %i response",
    async (status) => {
      let encodedProof = "";
      let signature = "";
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        if (fetchImpl.mock.calls.length === 1) {
          return Response.json(signInRequired(), { status: 402 });
        }
        const request = input as Request;
        encodedProof = request.headers.get("sign-in-with-x") ?? "";
        signature = String(
          (
            JSON.parse(Buffer.from(encodedProof, "base64").toString("utf8")) as {
              signature: unknown;
            }
          ).signature,
        );
        return new Response(
          JSON.stringify({
            reflectedHeader: `received ${encodedProof}`,
            nested: { reflectedSignature: `signature=${signature}` },
            [encodedProof]: `key with ${signature}`,
          }),
          {
            status,
            headers: { "content-type": `application/json; reflected=${encodedProof}` },
          },
        );
      });

      const result = await readPaidOrigin(readerArgs(fetchImpl));
      const returned = JSON.stringify(result);

      expect(encodedProof).not.toBe("");
      expect(signature).not.toBe("");
      expect(returned).not.toContain(encodedProof);
      expect(returned).not.toContain(signature);
      expect(returned).toContain("[redacted]");
      expect(result.status).toBe(status);
    },
  );

  it("redacts a reflected SIWX proof from signed request errors", async () => {
    let encodedProof = "";
    let signature = "";
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (fetchImpl.mock.calls.length === 1) {
        return Response.json(signInRequired(), { status: 402 });
      }
      encodedProof = (input as Request).headers.get("sign-in-with-x") ?? "";
      signature = String(
        (JSON.parse(Buffer.from(encodedProof, "base64").toString("utf8")) as { signature: unknown })
          .signature,
      );
      throw new Error(`upstream echoed ${encodedProof}`, {
        cause: new Error(`signature=${signature}`),
      });
    });

    let thrown: unknown;
    try {
      await readPaidOrigin(readerArgs(fetchImpl));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    const returned = `${error.message}\n${error.cause instanceof Error ? error.cause.message : ""}`;
    expect(returned).not.toContain(encodedProof);
    expect(returned).not.toContain(signature);
    expect(returned).toContain("[redacted]");
  });

  it("never pays a priced 402 without SIWX", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(paymentRequired());

    await expect(readPaidOrigin(readerArgs(fetchImpl))).rejects.toThrow("call.read never pays");
    expect(mocks.completeX402Payment).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("refuses a priced 402 with SIWX before signing", async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signMessage");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(pricedSignInRequired(), { status: 402 }));

    await expect(readPaidOrigin({ ...readerArgs(fetchImpl), account })).rejects.toThrow(
      "call.read never pays",
    );
    expect(signSpy).not.toHaveBeenCalled();
    expect(mocks.completeX402Payment).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    ["an x402 v1 maxAmountRequired", { maxAmountRequired: "2500", amount: undefined }],
    ["an unreadable amount", { amount: "2.5" }],
  ])("refuses a SIWX 402 priced with %s before signing", async (_label, override) => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    const signSpy = vi.spyOn(account, "signMessage");
    const challenge = { ...signInRequired(), accepts: [{ ...paymentOffer(), ...override }] };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(challenge, { status: 402 }));

    await expect(readPaidOrigin({ ...readerArgs(fetchImpl), account })).rejects.toThrow(
      "call.read never pays",
    );
    expect(signSpy).not.toHaveBeenCalled();
    expect(mocks.completeX402Payment).not.toHaveBeenCalled();
  });

  it("never pays when the signed retry is still 402", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(signInRequired(), { status: 402 }))
      .mockResolvedValueOnce(paymentRequired());

    await expect(readPaidOrigin(readerArgs(fetchImpl))).rejects.toThrow("call.read never pays");
    expect(mocks.completeX402Payment).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("refuses the action outside an agent run", async () => {
    await expect(runAction(callRead, { url: RESOURCE_URL }, actionContext())).rejects.toThrow(
      "call.read only works inside an agent run",
    );
  });

  it("times out a fetch that never returns", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));

    await expect(readPaidOrigin({ ...readerArgs(fetchImpl), timeoutMs: 10 })).rejects.toThrow(
      "call.read timed out after 10 ms",
    );
  });

  it("times out while consuming a stalled response body", async () => {
    let cancelled = false;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull() {},
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      ),
    );

    await expect(readPaidOrigin({ ...readerArgs(fetchImpl), timeoutMs: 10 })).rejects.toThrow(
      "call.read timed out after 10 ms",
    );
    expect(cancelled).toBe(true);
  });
});

function readerArgs(fetchImpl: typeof fetch) {
  return {
    url: RESOURCE_URL,
    paidOrigins: new Set([RESOURCE_ORIGIN]),
    account: privateKeyToAccount(PRIVATE_KEY),
    config: getDefaultConfig(),
    fetchImpl,
  };
}

function signInRequired() {
  return {
    x402Version: 2,
    accepts: [],
    extensions: {
      "sign-in-with-x": {
        info: {
          domain: "93.184.216.34",
          uri: RESOURCE_URL,
          statement: "Sign in to view this resource",
          version: "1" as const,
          nonce: "abcdefgh",
          issuedAt: "2026-09-30T08:00:00.000Z",
        },
        supportedChains: [{ chainId: BASE_MAINNET_CAIP2, type: "eip191" as const }],
        schema: { type: "object" },
      },
    },
  };
}

function pricedSignInRequired() {
  return { ...signInRequired(), accepts: [paymentOffer()] };
}

function paymentRequired(): Response {
  return Response.json(
    {
      x402Version: 2,
      resource: { url: RESOURCE_URL },
      accepts: [paymentOffer()],
    },
    { status: 402 },
  );
}

function paymentOffer() {
  const config = getDefaultConfig();
  return {
    scheme: "exact",
    network: BASE_MAINNET_CAIP2,
    amount: "2500",
    asset: config.networks[BASE_MAINNET_CAIP2]!.usdc,
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
}

function actionContext(): ActionContext {
  const unavailable = async (): Promise<never> => {
    throw new Error("This port must not run.");
  };
  return {
    config: getDefaultConfig(),
    clock: () => new Date("2026-09-30T08:00:00.000Z"),
    call: { search: unavailable, inspect: unavailable, pay: unavailable },
    caller: { surface: "mcp" },
  };
}
