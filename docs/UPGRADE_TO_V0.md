# Upgrade to omnichain v0 (Phase 1)

Consumer-facing migration guide for the changes shipped by the initial
`feature/sinan-py-parity` branch. **This is the "quick alignments" phase only.**
The follow-up branch (`feature/sinan-py-parity-2`) will add architectural
changes (Decimal amount type, TransactionStatus split, nested balanceChanges,
`verifyMessageSignature` removal, `FeePriority` threading, TON port); those
migrations will land in a separate section here.

---

## Chain IDs

### Solana chainId renumber

- **What**: Solana chainId constants changed to match Python.
  - `CHAIN_ID_SOLANA_MAINNET`: `-100` → `-2000`
  - `CHAIN_ID_SOLANA_TESTNET`: `-101` → `-2001`
  - `CHAIN_ID_SOLANA_DEVNET`: `-102` → `-2002`
- **Python source**: `omnichain-py/src/omnichain/chain_ids.py`
- **Legacy shim**: the pre-v0 IDs `-100/-101/-102` are still registered as
  `NetworkType.SOLANA` at module load, so `addressFor(-100, ...)` continues
  to work during migration. Use `migrateLegacySolanaChainId(id)` to rewrite
  persisted rows to the canonical v0 value:
  ```ts
  import { migrateLegacySolanaChainId } from '@getomnichain/omnichain';
  const canonical = migrateLegacySolanaChainId(row.chainId);
  ```
- **Consumer action**: schedule a one-time SQL rewrite:
  ```sql
  UPDATE <table> SET chain_id = -2000 WHERE chain_id = -100;
  UPDATE <table> SET chain_id = -2001 WHERE chain_id = -101;
  UPDATE <table> SET chain_id = -2002 WHERE chain_id = -102;
  ```

### Solana chain names

- **What**:
  - `SolanaMainnet.name`: `'Solana'` → `'Solana Mainnet'`
  - `SolanaTestnet.name`: unchanged
  - `SolanaDevnet.name`: unchanged
- **Python source**: `omnichain-py/impl/solana/chains.py`
- **RPC env-var impact**: the derived key changed from `SOLANA_RPC_URL` to
  `SOLANA_MAINNET_RPC_URL`. `SolanaMainnet` declares the pre-v0
  `SOLANA_RPC_URL` as a legacy fallback (`legacyRpcEnvNames`) so existing
  deployments keep working. Rename at your convenience.

### BNB Chain name

- **What**: `BnbChain.name`: `'BNB Chain'` → `'Bnb Chain'`.
- **Env-var derivation identical** (both cases produce `BNB_CHAIN_RPC_URL`).
  Cosmetic-only for display strings.

---

## RPC handling

### Solana second env-var fallback

- **What**: `SolanaChain.readRpcUrl` fallback chain expanded:
  1. constructor `rpcUrl`
  2. env `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL`
  3. env `SOLANA_<chainId>_RPC_URL` (signed, matches Python — e.g. `SOLANA_-2000_RPC_URL`)
  4. env from `legacyRpcEnvNames` (per-instance)
  5. `defaultRpcUrl` (public cluster)
- **Python source**: `impl/solana/base.py:420-434`
- **Consumer action**: additive — existing setups keep working. Consumers
  can now set `SOLANA_-2000_RPC_URL` for per-cluster overrides.
- **Note**: TS matches Python's signed-chainId env-var name exactly
  (`SOLANA_-2000_RPC_URL`). Shell operators (bash/zsh/sh can't set that
  key syntax) must use dotenv, Docker, or k8s to inject it. Divergence
  noted in `SINAN_OPEN_QUESTIONS.md` for upstream discussion.

---

## Token / Asset model

### `Token.equals` no longer compares decimals

- **What**: `Token.equals(other)` compares `(chainId, symbol, identifier)`.
  `decimals` no longer part of identity.
- **Python source**: `base/base.py:60-65`
- **New**: `Token.strictEquals(other)` includes decimals — use before amount
  scaling. `Token.sameAsset(other)` compares `(chainId, identifier)` only,
  ignoring symbol drift.
- **Consumer action**: audit any `Set<Token>` or `Map<Token>` dedup logic;
  two tokens with different declared decimals now collapse under `equals`.

### `ARBITRUM_USDT` symbol change

- **What**: `ARBITRUM_USDT.symbol` changed `'USDT'` → `'USD₮0'` (matches
  Python's on-chain symbol at `impl/evm/assets.py:41`).
- **Consumer action**: dedup / allowlist logic comparing tokens by symbol
  may now miss. Use `sameAsset` for identifier-based matching, or
  `strictEquals` if you also want decimals asserted. The non-ASCII `₮`
  will also affect ASCII-only log pipelines and DB columns.

### `EvmToken.identifier` is always EIP-55 checksummed

- **What**: the `EvmToken` constructor now normalizes `identifier` to EIP-55
  checksum form (previously round-tripped whatever the caller passed).
  `new EvmToken(1, 'USDT', '0xdac17f95…', 6).identifier` is now
  `'0xdAC17F958D2ee523a2206206994597C13D831ec7'`.
- **Rationale**: without this, a consumer-built lowercase USDT wouldn't
  `sameAsset`-match the pre-baked `ETHEREUM_USDT`, and
  `requiresZeroResetApproval` would silently return `false`.
- **Consumer action**: audit any code that stores `token.identifier` in a
  DB column with a canonical-lowercase convention, or compares
  `token.identifier` against a raw hex string. Case-normalize on the
  consumer side, or key everything on `.toLowerCase()`.
- **BalanceChange casing note**: `BalanceChange.address` is emitted
  lowercase (wire-friendly), while `BalanceChange.token.identifier` is now
  EIP-55. Do not compare the two casings directly — pass through
  `EvmAddress(x).toChecksum()` or `.toLowerCase()` for whichever
  convention you use.

### `requiresZeroResetApproval(token)` predicate

- **What**: new export replacing the array-based membership check for
  `EVM_ASSETS_REQUIRING_ZERO_RESET_APPROVAL` (USDT-on-Ethereum's
  approve-quirk). Uses `sameAsset` internally so a consumer-constructed
  USDT token still matches.
- **Consumer action**: replace `EVM_ASSETS_REQUIRING_ZERO_RESET_APPROVAL.includes(t)`
  with `requiresZeroResetApproval(t)`. The declarative array is still
  exported.

---

## `registerNonEvmChain` throws on family conflict

- **What**: attempting to register a chainId with a `NetworkType` different
  from an existing registration (either from the static family seed or a
  prior instance construction) now throws
  `ChainError(InvalidArgument)` at construction time.
- **Rationale**: a silently-flipped family causes address parsing to be
  routed through the wrong grammar (e.g. base58 Solana → BTC).
- **Consumer action**: `import`-time crash if your custom chain uses an ID
  that collides with a seeded family. Static seeds shipped in v0:
  - BTC family: `-1`, `-2`, `-3`, `-10`, `-12`, `-14`, `-16`, `-18`
  - Solana family: `-2000`, `-2001`, `-2002` (+ legacy aliases `-100`, `-101`, `-102`)
  - TON family: `-4000`, `-4001`
  - Tron family: `728126428`, `2494104990`
- Diff your custom chainIds against these before upgrading.

## `networkTypeOf` fail-closed for unregistered negative chainIds

- **What**: `networkTypeOf(chainId)` now throws `ChainError(ChainNotSupported)`
  for unregistered negative chainIds instead of silently returning EVM.
  Positive IDs still default to EVM.
- **Rationale**: the previous silent fallback made a Solana `-100` load into
  the EVM address path, so `IsAddress` rejected valid Solana addresses.
- **Consumer action**: none, if you use pre-baked chains. If you construct
  UTXO chains lazily (they register in the constructor), do so at module
  load rather than first use; or import the chain-family module so
  registration happens statically.

---

## EVM priority tiers

- **What**: `EvmChain.suggestGas` aligned to Python `_FEE_PRIORITY_PROFILE`:
  - Reward percentile: `SLOW=25`, `NORMAL=50`, `FAST=75` (was 90)
  - Legacy multiplier: `SLOW=1.0×`, `NORMAL=1.2×`, `FAST=1.5×` (was 2.0×)
- **Python source**: `impl/evm/base.py:440-444`
- **Consumer action**: `FAST` fee suggestions become materially lower.
- **1559 aggregation**: sort tips across the 10 sampled blocks, pick the p90
  element. Python parity (`impl/evm/base.py:1122-1125`).
- **Empty-reward fallback**: 2 gwei (`impl/evm/base.py:1124`).
- **RPC failure**: bubbles as `ChainError(RpcError)` — no defensive
  `getFeeData × multiplier` fallback. Python bubbles too.

---

## Additive (informational — not breaking)

### New EVM chains, tokens, and chain-ID constants

- 48 pre-baked `EvmChain` instances in `evm_chains.ts` (Optimism, Polygon,
  Avalanche, Celo, Linea, Scroll, Blast, Sei, Monad, Sonic, HyperEVM,
  MegaETH, Mantle, ZKSync, ZetaChain, etc.). Each mirrors Python
  `impl/evm/chains.py` line-for-line.
- 54 pre-baked EVM tokens (`evm_tokens.ts`) mirroring
  `impl/evm/assets.py`.
- New root module `chain_ids.ts` exports every constant Python's
  `chain_ids.py` defines: BTC family (`-1..-3`), LTC (`-10`), DOGE (`-12`),
  DASH (`-14`), ZCASH (`-16`), BCH (`-18`), plus 48 EVM chain IDs.

### New Solana tokens

- `SOLANA_USDC`, `SOLANA_EURC`, `SOLANA_WSOL`, `SOLANA_PYUSD`,
  `SOLANA_USDT`, `SOLANA_TESTNET_SOL`, `SOLANA_DEVNET_SOL`,
  `SOLANA_DEVNET_USDC`, `SOLANA_DEVNET_EURC`. Mirrors
  `impl/solana/assets.py`.

### `EvmChain` init gains `nativeTransferGasLimit` + `nativeTransferGasMultiplier`

- **What**: two new optional init fields, defaults 21000 and 1.4 (Python
  parity). Scroll and MegaETH set custom values.
- **v0 status**: **declarative-only** — stored on the chain instance and
  readable by consumers, but not yet consumed by
  `createTransferUnsignedTransaction`. Wired into the builder in the
  follow-up architectural PR.

---

## Deferred to Phase 2 branch (`feature/sinan-py-parity-2`)

- Amount type: switch to `Decimal` (adds `decimal.js` dep).
- `TransactionStatus` split into lean base + `EvmTransactionStatus` /
  `SolanaTransactionStatus` / `UtxoTransactionStatus` subclasses.
- `balanceChanges` reshape to `Map<wallet, Map<identifier, AssetBalanceChange>>`.
- `verifyMessageSignature` removal from `Chain` (Python puts on Wallet).
- `FeePriority` / `AbstractGasPricing`-style overrides accepted by every
  transfer builder.
- TON chain / token / transfer implementation.

Each will get its own section in this file when landed.
