import { describe, expect, it } from "vitest";

import { discoveryEndpointSchema } from "./index.js";

const endpoint = {
  name: "weather",
  method: "POST",
  url: "https://weather.example/call",
  price: "$0.005",
  description: "Current weather.",
};

describe("Call endpoint response contract", () => {
  it("preserves a response schema and an example request", () => {
    const responseSchema = {
      type: "object",
      properties: { temperatures: { type: "array", items: { type: "number" } } },
    };
    const exampleRequest = { query: { units: "celsius" }, body: { city: "Amsterdam" } };
    expect(discoveryEndpointSchema.parse({ ...endpoint, responseSchema, exampleRequest })).toEqual({
      ...endpoint,
      responseSchema,
      exampleRequest,
    });
    expect(discoveryEndpointSchema.parse(endpoint)).toEqual(endpoint);
  });

  it("drops malformed optional response fields without losing the endpoint", () => {
    for (const exampleRequest of [null, "Amsterdam", [], { body: () => "not JSON" }]) {
      const parsed = discoveryEndpointSchema.parse({
        ...endpoint,
        exampleRequest,
        responseSchema: () => "not JSON",
      });
      expect(parsed).toMatchObject(endpoint);
      expect(parsed.exampleRequest).toBeUndefined();
      expect(parsed.responseSchema).toBeUndefined();
    }
  });

  it("drops a malformed example query while preserving its JSON body", () => {
    const parsed = discoveryEndpointSchema.parse({
      ...endpoint,
      exampleRequest: { query: { units: 10 }, body: { city: "Amsterdam" } },
    });
    expect(parsed.exampleRequest?.query).toBeUndefined();
    expect(parsed.exampleRequest?.body).toEqual({ city: "Amsterdam" });
  });
});
