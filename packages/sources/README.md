# `@vapi-network/sources`

Discovery adapters for [vAPI Network](https://github.com/vAPI-Network/vapi-network):
the vAPI Registry, the Coinbase Bazaar `/discovery/resources` catalogue, and
local JSON files. Results implement the `Source` and `Listing` contracts from
`@vapi-network/core` and keep their source provenance, so a caller never needs
a source-specific branch.

One entry point, `@vapi-network/sources`, exporting `vapiRegistrySource`,
`bazaarSource`, `localFileSource` and `x402scanSource`. The x402scan adapter is
intentionally a stub until x402scan documents a stable public read API.

## Exports

### Runtime exports

| Name                      | What it is                                                                                                                                                         | Since            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `bazaarSource`            | function (facilitatorUrl: string, options: BazaarSourceOptions = {}): Source                                                                                       | 0.5.0 or earlier |
| `findMarketplaceApiByRef` | function (ref: string, config: VapiRegistryConfig, fetchImpl?: Fetch): Promise<MarketplaceHit \| null>                                                             | 0.5.0 or earlier |
| `localFileSource`         | function (path: string): Source                                                                                                                                    | 0.5.0 or earlier |
| `mapBazaarItem`           | function (value: unknown, sourceUrl: string): Listing \| undefined                                                                                                 | 0.5.0 or earlier |
| `resolveServiceEndpoint`  | function (id: string, config: VapiRegistryConfig, fetchImpl?: Fetch, endpointName?: string): Promise<DiscoveryEndpoint>                                            | 0.5.0 or earlier |
| `resolveServiceListing`   | function (id: string, config: VapiRegistryConfig, fetchImpl?: Fetch, endpointName?: string): Promise<ResolvedListing>                                              | 0.5.0 or earlier |
| `searchMarketplace`       | function (input: MarketplaceSearchInput, config: VapiRegistryConfig, fetchImpl?: Fetch, options: MarketplaceSearchOptions = {}): Promise<MarketplaceDiscoveryPage> | 0.5.0 or earlier |
| `vapiRegistrySource`      | function (baseUrl: string, options: VapiRegistrySourceOptions = {}): Source                                                                                        | 0.5.0 or earlier |
| `x402scanSource`          | function (): Source                                                                                                                                                | 0.5.0 or earlier |

### Types

| Name                        | What it is                                                                                                                                                                                                                              | Since            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BazaarSourceOptions`       | type BazaarSourceOptions = GuardedSourceOptions                                                                                                                                                                                         | 0.5.0 or earlier |
| `MarketplaceSearchInput`    | type MarketplaceSearchInput = { query?: string; kinds?: MarketplaceKind[]; network?: string; limit?: number; cursor?: string; includeUnverified?: boolean; }                                                                            | 0.5.0 or earlier |
| `MarketplaceSearchOptions`  | type MarketplaceSearchOptions = Readonly<{ searchesPath?: string; now?: Date; nowMs?: () => number; notice?: (message: string) => void; }>                                                                                              | 0.5.0 or earlier |
| `VapiRegistryConfig`        | type VapiRegistryConfig = Readonly<{ discoveryUrl: string; marketplaceDiscoveryUrl: string; registryFallbacks?: ReadonlyArray< Readonly<{ discoveryUrl: string; marketplaceDiscoveryUrl: string }> >; allowPrivateNetwork?: boolean; }> | 0.5.0 or earlier |
| `VapiRegistrySourceOptions` | type VapiRegistrySourceOptions = GuardedSourceOptions & Readonly<{ discoveryUrl?: string; }>                                                                                                                                            | 0.5.0 or earlier |

See the [root README](https://github.com/vAPI-Network/vapi-network/blob/main/docs/call.md) for how the client merges and de-duplicates sources.
