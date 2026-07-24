# Upgrading omnichain

This file is the **integrator's action list** for every omnichain release that
requires consumer code changes. If your build stops working after you bump the
submodule (or the npm package, once we're on npm), start here.

For a full narrative of what shipped in each release — including additive
features that don't require integrator changes — see [CHANGELOG.md](./CHANGELOG.md).

Most recent breaking release at the top.

---

## Upgrading from 0.5.x to 0.6.0 (+ Unreleased Solana decoder fixes)

Two things ship together to consumers pulling the latest `main`:

1. **Breaking**: `EvmChain` / `SolanaChain` now accept `rpcUrl` at construction; `rpcEnvVar` is removed. ([PR #5](https://github.com/pluton-bridge/omnichain/pull/5))
2. **Behavioral fix**: Solana `TransactionStatus.balanceChanges` for SPL tokens is now correct (decimals, address, symbol). ([PR #7](https://github.com/pluton-bridge/omnichain/pull/7))

You need to act on **(1)** — your build fails without it. You *may* need to act on **(2)** — only if you have workarounds in place for the old bugs.

---

### 1. `rpcUrl` at construction (breaking)

#### What changed

| | Before (0.5.x) | After (0.6.0) |
|---|---|---|
| `EvmChainInit.rpcEnvVar` | `string` (required) | ❌ removed |
| `EvmChainInit.rpcUrl` | — | `string` (optional) |
| `SolanaChainInit.rpcEnvVar` | `string` (required) | ❌ removed |
| `SolanaChainInit.defaultRpcUrl` | — | `string` (**required**) |
| `SolanaChainInit.rpcUrl` | — | `string` (optional) |
| `UtxoChain` / `BtcChain` init | (unchanged) | (unchanged) |

Resolution precedence when a provider is first needed:

**EVM**:
1. constructor `rpcUrl`
2. env `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL` (e.g. `ARBITRUM_RPC_URL`)
3. env `EVM_<chainId>_RPC_URL` (e.g. `EVM_42161_RPC_URL`)
4. throws `ChainError(RpcNotConfigured)`

**Solana**:
1. constructor `rpcUrl`
2. env `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL`
3. `defaultRpcUrl` (public cluster) — **never throws**

Env-var names are derived from the chain's `name` (Sinan's Python convention: `name.replace(' ', '_').upper()`).

#### Env-var name drift (watch this)

The old TS side hard-coded env-var names via `rpcEnvVar`. The new side derives them from `name`. **Two chains change env-var names**:

| Chain | Old env var | New primary env var | Secondary fallback |
|---|---|---|---|
| BNB Chain (`chainId: 56`) | `BNB_RPC_URL` | `BNB_CHAIN_RPC_URL` | `EVM_56_RPC_URL` |

Everything else keeps the same env var (`ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `BASE_RPC_URL`, `SOLANA_RPC_URL`, `SOLANA_TESTNET_RPC_URL`, `SOLANA_DEVNET_RPC_URL`) — the derivation happens to match.

Three ways to handle the BNB rename, pick one:
- Rename the env var in your deployment: `BNB_RPC_URL` → `BNB_CHAIN_RPC_URL`.
- Set `EVM_56_RPC_URL` instead (works for any chainId, no coupling to `name`).
- Pass `rpcUrl` explicitly at construction (recommended for production — see below).

#### Migration steps

**Step 1 — remove `rpcEnvVar` from all chain construction sites**

Consumer TypeScript that constructs an `EvmChain` or `SolanaChain`:

```diff
 new EvmChain({
   chainId: 42161,
   name: 'Arbitrum',
   blockTimeSeconds: 0.25,
   explorerBaseUrl: 'https://arbiscan.io',
   nativeSymbol: 'ETH',
-  rpcEnvVar: 'ARBITRUM_RPC_URL',
+  rpcUrl: process.env.ARBITRUM_RPC_URL,   // recommended: explicit
 });
```

For Solana, you additionally need `defaultRpcUrl`:

```diff
 new SolanaChain({
   chainId: -100,
   name: 'Solana',
   blockTimeSeconds: 0.4,
   explorerBaseUrl: 'https://solscan.io',
   nativeSymbol: 'SOL',
-  rpcEnvVar: 'SOLANA_RPC_URL',
+  defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
+  rpcUrl: process.env.SOLANA_RPC_URL,     // recommended: explicit
   chainAgnosticGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
 });
```

**Step 2 — update your config/service layers that carry `rpcEnvVar` in their types**

Example: pluton's `ChainRegistryService`:

```diff
 interface EvmChainSpec {
   chainId: number;
   name: string;
   blockTimeSeconds: number;
   explorerBaseUrl: string;
   nativeSymbol: string;
-  rpcEnvVar: string;
+  rpcUrl?: string;
   supportsEip1559?: boolean;
 }
```

And update the corresponding `config.yaml` entries (or wherever the specs are loaded):

```diff
 CHAINS_EVM:
   - chainId: 42161
     name: Arbitrum
     blockTimeSeconds: 0.25
     explorerBaseUrl: https://arbiscan.io
     nativeSymbol: ETH
-    rpcEnvVar: ARBITRUM_RPC_URL
+    rpcUrl: ${ARBITRUM_RPC_URL}      # env-interpolated at config load
```

Recommended service pattern — resolve URL from your config service before construction:

```ts
onModuleInit(): void {
  for (const spec of this.readEvmSpecsFromConfig()) {
    const rpcUrl = spec.rpcUrl ?? this.config.get<string>(`RPC_URL_${spec.chainId}`);
    this.chainsById.set(spec.chainId, new EvmChain({ ...spec, rpcUrl }));
  }
}
```

**Step 3 — update tests and examples**

Tests should read `.env` explicitly and pass the URL to the constructor rather than relying on the env-fallback:

```diff
 import { EvmChain } from 'omnichain/evm';

 const arbitrum = new EvmChain({
   chainId: 42161,
   name: 'Arbitrum',
   blockTimeSeconds: 0.25,
   explorerBaseUrl: 'https://arbiscan.io',
   nativeSymbol: 'ETH',
+  rpcUrl: process.env.ARBITRUM_RPC_URL,
 });
```

The env-fallback still works for the predefined `Arbitrum` / `Ethereum` / `Base` / `BnbChain` singletons — those are constructed without `rpcUrl`, so the SDK looks up the env var at first RPC call. Fine for scripts / one-off tests; **prefer explicit `rpcUrl` in production code** so URL provenance is visible.

**Step 4 — update anywhere that pattern-matches `ChainError` on `envVar`**

The `ChainError` meta shape for `RpcNotConfigured` changed:

```diff
- { chainId, envVar: 'ARBITRUM_RPC_URL' }
+ { chainId, envCandidates: ['ARBITRUM_RPC_URL', 'EVM_42161_RPC_URL'] }
```

If you have code inspecting `err.meta.envVar`, switch to `err.meta.envCandidates` (array of the fallback chain that was tried).

---

### 2. Solana `TransactionStatus.balanceChanges` — SPL fixes (behavior change)

#### What changed

Three bugs in the SPL token-balance decoder were fixed. If you consume `SolanaChain.getTransactionStatus(txHash).balanceChanges` and read SPL entries, output is now correct where before it was wrong or missing.

| Field | Before | After |
|---|---|---|
| `token.decimals` | always `0` | real decimals from `uiTokenAmount.decimals` |
| `address` (when RPC owner is `null`) | fell back to the **mint address** — treated as a wallet | entry dropped from output |
| `token.symbol` | `''` (empty) — construction actually throws | `UNKNOWN_<first-4-mint-chars>` placeholder |

Metadata resolution (real symbols via Metaplex) is **not** in this change — deferred as a feature.

#### What to check in consumer code

Search your codebase for these workarounds and remove them:

- **Formatters that hard-coded `decimals = 6` (or any fallback)** when the incoming `SolanaToken.decimals` was `0`. Delete the fallback — the SDK now delivers correct decimals.
- **Filters like `change.address !== mintAddress`** guarding against the null-owner bug. Delete — never fires now.
- **Any `try/catch` around `SolanaToken` construction** that was silently swallowing the empty-symbol throw. That throw no longer happens; if you were relying on it as a signal, adapt.

#### New behavior to be aware of

Consumers that dedupe or group `balanceChanges` by `(address, token.identifier)` will see **strictly fewer** entries after this change (the null-owner drops). Positive numeric changes should still match the sum of transfers observed in the tx; the loss is only entries where address was previously bogus.

Consumers matching on `token.symbol === ''` to detect "unresolved SPL token" should switch to `token.symbol.startsWith('UNKNOWN_')` or check `token.identifier === <mint>` directly.

---

## Verification checklist

After you bump the submodule and apply the migrations:

- [ ] `tsc --noEmit` clean.
- [ ] `nest build` (or equivalent) clean.
- [ ] Grep your codebase — no remaining references to `rpcEnvVar` (in code, config files, YAML).
- [ ] Grep — no remaining hard-coded `decimals = 0` or `decimals = 6` fallbacks on SPL token balance changes.
- [ ] Grep — no remaining `change.address !== <mintAddress>` guards on Solana balance changes.
- [ ] Predefined chain usage: `SolanaMainnet`, `SolanaTestnet`, `SolanaDevnet`, `Ethereum`, `Arbitrum`, `Base`, `BnbChain` still work without any init changes on your side.
- [ ] For `BNB Chain`: env var was renamed (or you've set `EVM_56_RPC_URL`, or you pass `rpcUrl` explicitly).
- [ ] If you custom-subclass `Chain` (rare), your subclass still compiles — no new abstract methods were added in this release.

## Support

Questions? Ping the omnichain maintainers or file an issue on the repo. Reference this file's section in the message so we can trace the confusion back to the doc if it's unclear.
