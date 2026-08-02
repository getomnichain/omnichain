# Multi-endpoint RPC config

Both `EvmChain` and `SolanaChain` constructors accept an optional `rpcUrls?: string[]` field alongside `rpcUrl?: string`.

## 0.3.0 status — single-entry only

**`rpcUrls` accepts at most ONE entry in 0.3.0.** Passing a longer list throws `ChainError(InvalidArgument)` at construction time. The field ships as a stable API surface; automatic failover-retry lands in a follow-up release. Consumers pinning `rpcUrls: [primary]` today will benefit as soon as retry-on-transport-error ships.

```ts
new EvmChain({ ..., rpcUrls: [process.env.ARBITRUM_PRIMARY_RPC_URL!] });   // OK
new EvmChain({ ..., rpcUrls: [primary, backup] });                          // throws — deferred
```

## Precedence

`rpcUrl` (single) → `rpcUrls[0]` → env-var chain → `defaultRpcUrl` (Solana only).

When `rpcUrls` is non-empty but every entry is blank, resolution throws `ChainError(RpcNotConfigured)`. **The SDK never silently falls back to a URL that isn't in the configured list or env fallback chain.**

## URL redactor

All error messages / thrown `ChainError.message` / logs pass through a redactor that strips:
- Query params ending in `key`, `token`, `secret` (`apiKey`, `api-key`, `api_key`, `key`, `access-token`, `secret`)
- `Authorization: Bearer <token>` (case-insensitive)
- Path-embedded keys under `/vN/` or `/api/` (≥16 alphanumeric or `_/-`)
- Full-URL match on known providers — Alchemy, Infura, QuickNode, Helius, Ankr, Blast, dRPC — collapses to `<scheme>://<host>/<redacted>`

Keyed URLs never appear in logs.
