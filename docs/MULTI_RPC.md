# Multi-endpoint RPC config

Both `EvmChain` and `SolanaChain` constructors accept `rpcUrls?: string[]` in addition to the existing `rpcUrl?: string`.

```ts
const chain = new EvmChain({
  chainId: 42161,
  name: 'Arbitrum One',
  blockTimeSeconds: 0.25,
  nativeSymbol: 'ETH',
  explorerBaseUrl: 'https://arbiscan.io',
  rpcUrls: [
    process.env.ARBITRUM_PRIMARY_RPC_URL!,
    process.env.ARBITRUM_BACKUP_RPC_URL!,
    'https://arb1.arbitrum.io/rpc',
  ],
});
```

## Precedence

`rpcUrl` (single) → `rpcUrls[0]` (primary of the list) → env-var chain → `defaultRpcUrl` (Solana only).

Endpoint order is authoritative — the SDK does not silently fall back to a URL that isn't in the configured list or env fallback chain.

## 0.3.0 status

Only the **primary** entry of `rpcUrls` is used at wire time in this release. **Automatic failover retry on 5xx / 429 / ECONNRESET / ETIMEDOUT lands in 0.3.1** — the API surface is stable so consumers pinning `rpcUrls: [primary, backup]` today will benefit as soon as the internal retry client ships. Until then, pass a single healthy endpoint or wrap the SDK with your own retry.

## URL redactor

All error messages / thrown `ChainError.message` / logs pass through a redactor that strips:
- `?apiKey=<key>` → `?apiKey=<redacted>`
- `?key=<key>` → `?key=<redacted>`
- `Authorization: Bearer <token>` → `Authorization: Bearer <redacted>`
- Path-embedded keys (Infura `/v3/<key>`, Alchemy `/v2/<key>`) → `/v3/<redacted>` / `/v2/<redacted>`

Keyed URLs never appear in logs — safe to pass Alchemy, Infura, QuickNode, Ankr URLs directly.
