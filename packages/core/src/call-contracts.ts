// Extracted from @vapi/call-contracts; catalog behavior intentionally unchanged.
import {
  discoveryResponseSchema,
  type DiscoveryEndpoint,
  type DiscoveryService,
} from "./call-contracts-wire.js";

export type CallTarget = DiscoveryEndpoint;

export type DiscoveryCatalogErrorCode =
  | "no_endpoint"
  | "ambiguous_default"
  | "malformed_url"
  | "blank_method"
  | "invalid_endpoint_name"
  | "duplicate_endpoint_name"
  | "service_not_found"
  | "endpoint_not_found"
  | "invalid_discovery";

export class DiscoveryCatalogError extends Error {
  readonly name = "DiscoveryCatalogError";
  readonly code: DiscoveryCatalogErrorCode;
  readonly serviceId: string | undefined;

  constructor(code: DiscoveryCatalogErrorCode, message: string, serviceId?: string) {
    super(message);
    this.code = code;
    this.serviceId = serviceId;
  }
}

export type DiscoveryCatalog = {
  services: DiscoveryService[];
  resolve(serviceId: string, endpointName?: string): CallTarget;
};

export function parseDiscovery(raw: unknown): DiscoveryCatalog {
  const parsed = discoveryResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const malformedUrl = parsed.error.issues.find(
      (issue) => issue.path.at(-1) === "url" && issue.path.includes("endpoints"),
    );
    if (malformedUrl) {
      const serviceIndex = pathIndexAfter(malformedUrl.path, "services");
      const serviceId = rawServiceId(raw, serviceIndex);
      throw new DiscoveryCatalogError(
        "malformed_url",
        `Service ${JSON.stringify(serviceId ?? "unknown")} has a malformed endpoint URL.`,
        serviceId,
      );
    }
    throw new DiscoveryCatalogError("invalid_discovery", "Discovery response is malformed.");
  }
  for (const service of parsed.data.services) {
    buildTargets(service);
  }

  return {
    services: parsed.data.services,
    resolve(serviceId, endpointName) {
      const service = parsed.data.services.find((candidate) => candidate.id === serviceId);
      if (!service) {
        throw new DiscoveryCatalogError(
          "service_not_found",
          `No payable endpoint found for service ${JSON.stringify(serviceId)}.`,
          serviceId,
        );
      }
      return resolveTarget(service, endpointName);
    },
  };
}

function resolveTarget(service: DiscoveryService, endpointName?: string): CallTarget {
  const { targets, targetsByName } = buildTargets(service);
  if (endpointName !== undefined) {
    const selected = targetsByName.get(endpointName.trim());
    if (!selected) {
      throw new DiscoveryCatalogError(
        "endpoint_not_found",
        `Service ${JSON.stringify(service.id)} has no endpoint ${JSON.stringify(endpointName)}. Available endpoints: ${[...targetsByName.keys()].join(", ")}.`,
        service.id,
      );
    }
    return { ...selected };
  }

  if (targets.size !== 1) {
    throw new DiscoveryCatalogError(
      "ambiguous_default",
      `Service ${JSON.stringify(service.id)} has ${targets.size} distinct payable endpoints. Choose one with endpoint: ${[...targetsByName.keys()].join(", ")}.`,
      service.id,
    );
  }

  return targets.values().next().value!;
}

function buildTargets(service: DiscoveryService): {
  targets: Map<string, CallTarget>;
  targetsByName: Map<string, CallTarget>;
} {
  if (service.endpoints.length === 0) {
    throw new DiscoveryCatalogError(
      "no_endpoint",
      `Service ${JSON.stringify(service.id)} has no payable endpoint.`,
      service.id,
    );
  }

  const namedEndpoints = [...service.endpoints].sort((left, right) =>
    compareNames(left.name.trim(), right.name.trim()),
  );
  const names = new Set<string>();
  const targets = new Map<string, CallTarget>();
  const targetsByName = new Map<string, CallTarget>();

  for (const endpoint of namedEndpoints) {
    const name = endpoint.name.trim();
    if (!name) {
      throw new DiscoveryCatalogError(
        "invalid_endpoint_name",
        `Service ${JSON.stringify(service.id)} has a blank endpoint name.`,
        service.id,
      );
    }
    if (names.has(name)) {
      throw new DiscoveryCatalogError(
        "duplicate_endpoint_name",
        `Service ${JSON.stringify(service.id)} has duplicate endpoint name ${JSON.stringify(name)}.`,
        service.id,
      );
    }
    names.add(name);

    const method = endpoint.method.trim().toUpperCase();
    if (!method) {
      throw new DiscoveryCatalogError(
        "blank_method",
        `Service ${JSON.stringify(service.id)} has a blank endpoint method.`,
        service.id,
      );
    }

    const url = new URL(endpoint.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new DiscoveryCatalogError(
        "malformed_url",
        `Service ${JSON.stringify(service.id)} has a non-HTTP endpoint URL.`,
        service.id,
      );
    }
    const transportKey = `${method}\u0000${endpoint.url}`;
    const normalized = { ...endpoint, name, method };
    targetsByName.set(name, normalized);
    if (!targets.has(transportKey)) targets.set(transportKey, normalized);
  }

  return { targets, targetsByName };
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathIndexAfter(path: PropertyKey[], key: PropertyKey): number | undefined {
  const keyIndex = path.indexOf(key);
  const candidate = path[keyIndex + 1];
  return typeof candidate === "number" ? candidate : undefined;
}

function rawServiceId(raw: unknown, serviceIndex: number | undefined): string | undefined {
  if (serviceIndex === undefined || typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const services = Reflect.get(raw, "services");
  if (!Array.isArray(services)) {
    return undefined;
  }
  const service = services[serviceIndex];
  if (typeof service !== "object" || service === null) {
    return undefined;
  }
  const id = Reflect.get(service, "id");
  return typeof id === "string" ? id : undefined;
}
