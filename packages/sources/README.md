# `@vapi-network/sources`

Discovery adapters for [vAPI Network](https://github.com/vAPI-Network/vapi-network):
the vAPI Registry, the Coinbase Bazaar `/discovery/resources` catalogue, and
local JSON files. Results implement the `Source` and `Listing` contracts from
`@vapi-network/core` and keep their source provenance, so a caller never needs
a source-specific branch.

One entry point, `@vapi-network/sources`, exporting `vapiRegistrySource`,
`bazaarSource`, `localFileSource` and `x402scanSource`. The x402scan adapter is
intentionally a stub until x402scan documents a stable public read API.

See the [root README](https://github.com/vAPI-Network/vapi-network#readme) for
how the client merges and de-duplicates sources.
