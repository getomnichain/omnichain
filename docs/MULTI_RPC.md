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

## Semantics

- The primary endpoint is the first URL in `rpcUrls`. When `rpcUrl` is ALSO set, it prepends.
- Endpoint order is authoritative. On failure, the SDK advances down the list — it never falls back to a URL that isn't in the configured list.
- Retryable errors: `5xx`, `429`, `ECONNRESET`, `ETIMEDOUT`. Non-retryable errors (revert, malformed input, `NonceTooLow`, etc.) short-circuit.

## URL redactor

All error messages / thrown `ChainError.message` / logs pass through a redactor that strips:
- `?apiKey=<key>` → `?apiKey=<redacted>`
- `?key=<key>` → `?key=<redacted>`
- `Authorization: Bearer <token>` → `Authorization: Bearer <redacted>`
- Path-embedded keys `/v3/<hex>/` → `/v3/<redacted>/`

Keyed URLs never appear in logs — safe to add Alchemy, Infura, QuickNode, Ankr URLs directly.
