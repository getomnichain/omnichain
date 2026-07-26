# Integrator migration guide — pre-v0-submodule → v0-npm

**Not committed** (local only, per project convention: one-time transition doc).

Every breaking change consumers must apply when moving from the pre-v0 submodule consumption to the v0-npm package. Grouped by area. Each entry cites the Sinan Python file:line that drove the change (source of truth).

Populated during the `feature/sinan-py-parity` branch work.

---

## Chain IDs and names

### Solana chainId renumber

- **What**: Solana chainId constants changed to match Python.
  - `SOLANA_MAINNET_CHAIN_ID`: `-100` → `-2000`
  - `SOLANA_TESTNET_CHAIN_ID`: `-101` → `-2001`
  - `SOLANA_DEVNET_CHAIN_ID`: `-102` → `-2002`
- **Python source**: `/tmp/omnichain-py/src/omnichain/chain_ids.py:43-50`
- **Consumer action**: any persisted `chainId` values for Solana rows must be updated. Migration script:
  ```sql
  UPDATE <table> SET chain_id = -2000 WHERE chain_id = -100;
  UPDATE <table> SET chain_id = -2001 WHERE chain_id = -101;
  UPDATE <table> SET chain_id = -2002 WHERE chain_id = -102;
  ```

### Solana chain names

- **What**: display + env-var-derivation name changed:
  - `'Solana'` → `'Solana Mainnet'`
  - `'Solana Testnet'` unchanged
  - `'Solana Devnet'` unchanged
- **Python source**: `/tmp/omnichain-py/src/omnichain/impl/solana/chains.py:5`
- **Consumer action**: env var rename `SOLANA_RPC_URL` → `SOLANA_MAINNET_RPC_URL`, OR set `SOLANA_-2000_RPC_URL` (second fallback), OR pass `rpcUrl` explicitly.

### BNB Chain name

- **What**: `'BNB Chain'` → `'Bnb Chain'`.
- **Python source**: `/tmp/omnichain-py/src/omnichain/impl/evm/chains.py:31`
- **Consumer action**: env-var derivation is identical (`BNB_CHAIN_RPC_URL` both cases — space→`_`, uppercased). Cosmetic-only for display strings.

---

## RPC handling

### Solana second env-var fallback

- **What**: `SolanaChain.readRpcUrl` fallback chain expanded:
  - `rpcUrl` → `<NAME>_RPC_URL` → **`SOLANA_<chainId>_RPC_URL`** → `defaultRpcUrl`
- **Python source**: `/tmp/omnichain-py/src/omnichain/impl/solana/base.py:424-434`
- **Consumer action**: additive — existing setups keep working. Consumers can now set `SOLANA_-2000_RPC_URL` in env for per-cluster overrides without knowing the display name.

---

## Token / Asset model

### `Token.equals` no longer compares decimals

- **What**: `Token.equals(other)` now compares `(chainId, symbol, identifier)`; `decimals` is no longer part of identity.
- **Python source**: `/tmp/omnichain-py/src/omnichain/base/base.py:60-65`
- **Consumer action**: `Set<Token>` or `Map<Token>` dedup semantics change. If two tokens with the same chain/symbol/identifier but different declared decimals existed in the same collection, they now collapse. Review any code holding Token instances in a hashable collection.

### `AbstractAsset._registry` — NOT ported to TS

- **What**: Python's global `_registry` + `search_registered_asset(chain_id, identifier)` + `get_registered_asset(chain_id, symbol, identifier)` are absent on TS.
- **Consumer action**: construct `Token` instances as needed; no cross-instance lookup. `SolanaChain._decodeBalanceChanges` emits `UNKNOWN_<mint4>` placeholder tokens rather than resolving; consumers wanting metadata must resolve out-of-band.

---

## EVM priority tiers

- **What**: EVM `suggestGas` priority-percentile and legacy multiplier tables aligned to Python.
  - Percentiles: `SLOW=25`, `NORMAL=50`, **`FAST=75`** (was 90).
  - Legacy multiplier: `SLOW=1.0×`, `NORMAL=1.2×`, **`FAST=1.5×`** (was 2.0×).
- **Python source**: `/tmp/omnichain-py/src/omnichain/impl/evm/base.py:440-444`
- **Consumer action**: fee-suggestion outputs change; expect lower `FAST` values. Nothing structurally breaks.

---

## Amount type (transfer builders)

- **What**: `createTransferUnsignedTransaction({ amount })` — amount changed from `bigint` (minor units) to `Decimal` (HR, human-readable).
- **Python source**: `/tmp/omnichain-py/src/omnichain/impl/evm/base.py:718-804`, `impl/solana/base.py:753-793`, `impl/utxo/base.py:1657-1712`
- **Dep**: `decimal.js` added to peer/dependencies.
- **Consumer action**: rewrite all call sites:
  ```ts
  // before
  await chain.createTransferUnsignedTransaction({ from, to, tokenIdentifier: usdcAddr, amount: 1_000_000n });
  // after
  await chain.createTransferUnsignedTransaction({ from, to, tokenIdentifier: usdcAddr, amount: new Decimal('1') });
  ```
- **`is_full_balance` sweep** support added: `{ ..., isFullBalance: true }` to sweep the sender's full native balance (fees subtracted).

---

## `TransactionStatus` split

- **What**: `TransactionStatus` interface split into a lean base + chain-specific subclasses:
  - `TransactionStatus` (base) — `{ chainId, statusType, inclusionDatetime, error, balanceChanges }`
  - `EvmTransactionStatus extends TransactionStatus` — adds `fees: EvmTransactionGasFees | null`, `logs: EvmParsedLog[]`
  - `SolanaTransactionStatus extends TransactionStatus` — adds `fees: SolanaTransactionFees | null`
  - `UtxoTransactionStatus extends TransactionStatus` — adds `confirmations`, `blockNumber`, `blockTimestamp`, `vsize`, `feeSats`
- **Python source**: `/tmp/omnichain-py/src/omnichain/base/base.py:361-399` and per-chain subclass files
- **Consumer action**: consumers reading `confirmations` / `blockNumber` / `gasFee` from the base must switch to per-chain narrowing:
  ```ts
  const status = await evmChain.getTransactionStatus(hash);
  if (status.statusType === 'Success') {
    const fees = status.fees; // EvmTransactionGasFees | null
    for (const log of status.logs) { ... }
  }
  ```

---

## `balanceChanges` reshape

- **What**: `TransactionStatus.balanceChanges` changed from `BalanceChange[]` (flat array) to `Map<walletAddress: string, Map<tokenKey: string, AssetBalanceChange>>` (nested).
  - `AssetBalanceChange` fields: `{ token: Token, balanceChangeHr: Decimal, balanceChangeMr: bigint }`
  - `tokenKey`: `identifier ?? '<native>'` — the string key inside the inner Map.
- **Python source**: `/tmp/omnichain-py/src/omnichain/base/base.py:239-313, 371-373`
- **Consumer action**: any code iterating `for (const c of status.balanceChanges)` needs to change:
  ```ts
  // before
  for (const c of status.balanceChanges) { /* c.address, c.token, c.amount */ }
  // after
  for (const [wallet, byToken] of status.balanceChanges) {
    for (const [_, change] of byToken) { /* change.token, change.balanceChangeHr, change.balanceChangeMr */ }
  }
  ```

---

## `verifyMessageSignature` removed from `Chain`

- **What**: `Chain.verifyMessageSignature` method removed. Python puts message-verification on `Wallet`, and TS has no Wallet layer in v0.
- **Python source**: `/tmp/omnichain-py/src/omnichain/impl/{evm,solana,ton}/base.py` — `verify_signature` methods on the `*Wallet` classes.
- **Consumer action**: **remove all `chain.verifyMessageSignature(...)` calls**. For EVM signature verification, callers can use `ethers.verifyMessage` directly until the Wallet layer is ported (tracked in Sinan open questions).

---

## FeePriority threaded into transfer builder

- **What**: `createTransferUnsignedTransaction` now accepts `priority?: Priority | EvmGasPricing | SolanaGasPricing | UtxoGasPricing`. Defaults to `Priority.NORMAL`.
- **Python source**: `/tmp/omnichain-py/src/omnichain/base/base.py:123-162` (`FeePriority`, `AbstractGasPricing`)
- **Consumer action**: existing calls without `priority` continue to work (default `NORMAL`). For explicit control, pass either the enum or a per-chain override object.

---

## Category C additive (informational — not breaking)

### New EVM chains predefined

40+ new predefined `EvmChain` instances exported from `evm/evm_chains.ts` (Optimism, Polygon, Avalanche, Celo, Linea, Scroll, Blast, Sei, Monad, Sonic, HyperEVM, MegaETH, Mantle, ZKSync, ZetaChain, and more). Each matches Python `/tmp/omnichain-py/src/omnichain/impl/evm/chains.py` line-for-line.

### New EVM tokens predefined

USDC/USDT/WETH/EURC/WBTC across the new chains, in `evm/evm_tokens.ts`. Matches Python `impl/evm/assets.py`.

### New Solana tokens

`SOLANA_USDC`, `SOLANA_EURC`, `SOLANA_WSOL`, `SOLANA_PYUSD`, `SOLANA_USDT`, plus devnet variants. New file `solana/solana_tokens.ts`.

### Bitcoin family chain-ID constants

New module `chain_ids.ts` exports: `CHAIN_ID_BITCOIN_MAINNET = -1`, `CHAIN_ID_BITCOIN_TESTNET = -2`, `CHAIN_ID_BITCOIN_SIGNET = -3`, `CHAIN_ID_LITECOIN_MAINNET = -10`, `CHAIN_ID_DOGECOIN_MAINNET = -12`. Consumers no longer need to invent their own.

### `USDT_REQUIRES_ZERO_RESET_APPROVAL` marker

New declarative export listing USDT-on-Ethereum's approve-quirk. Consumers with an approval layer should consult this before issuing a fresh approve. Not enforced by the SDK (no prerequisite layer).

---

## TON

**Not supported in v0.** Python has full `TonChain`; TS exports only `TonAddress`. Ports in Sinan open questions for post-v0.

---

## Doc removals

- `verifyMessageSignature` sections removed from `docs/*.md`.
- Any doc example using `bigint` amounts updated to `Decimal`.
