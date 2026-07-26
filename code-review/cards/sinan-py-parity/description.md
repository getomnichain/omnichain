# Sinan omnichain-py v0 parity — Phases 0-2 checkpoint

Status: Draft (checkpoint review; Phases 3+ deferred to a follow-up branch)

## Summary

Align the TypeScript omnichain surface with Sinan's Python source of truth at https://github.com/getomnichain/omnichain-py in preparation for the v0 npm release under `@getomnichain/omnichain`.

This branch ships **Phases 0-2 only** — the "quick alignments" and "additive" changes. The larger architectural rewrites (Decimal amounts, TransactionStatus split, nested balanceChanges, verifyMessageSignature removal) are deferred to a follow-up branch (`feature/sinan-py-parity-2`).

Every change in this branch cites its counterpart in the Python source (file:line) — commit body and inline comments both.

## Scope

### Included

**Phase 0 — Tooling**:
- Rename `code-review/review.py` → `code-review/code_reviewer.py` (naming convention with rango-intents).
- Add local-only tracking docs `INTEGRATOR_MIGRATION_v0.md` and `SINAN_OPEN_QUESTIONS.md` (gitignored).

**Phase 1 — Category A quick alignments** (all mirror Sinan):
- Solana chainIds `-100/-101/-102` → `-2000/-2001/-2002` (chain_ids.py:43-45).
- Solana chain names → `"Solana Mainnet"`, `"Solana Testnet"`, `"Solana Devnet"` (impl/solana/chains.py:5-27).
- BNB Chain name → `"Bnb Chain"` (impl/evm/chains.py:31).
- Solana RPC fallback: `rpcUrl → <NAME>_RPC_URL → SOLANA_<chainId>_RPC_URL → defaultRpcUrl` (impl/solana/base.py:421-434).
- `Token.equals` compares `(chainId, symbol, identifier)` only, no decimals (base/base.py:60-65).
- EVM priority: FAST percentile 90 → 75, legacy multiplier 2.0× → 1.5× (impl/evm/base.py:440-444).
- `EvmChainInit` gains `nativeTransferGasLimit` (default 21000) + `nativeTransferGasMultiplier` (default 1.4) (impl/evm/base.py:479-480).

**Phase 2 — Category C additive**:
- New `chain_ids.ts`: every constant + `CHAIN_FAMILY_*` set + `is*` predicate mirrored from chain_ids.py.
- `evm_chains.ts` rewritten: 48 pre-baked chains, each linked to its `impl/evm/chains.py:LN` counterpart.
- `evm_tokens.ts` rewritten: 55 pre-baked tokens — 53 mirroring `impl/evm/assets.py` + 2 TS-only convenience natives (`CELO_SEPOLIA_CELO`, `MOONBEAM_GLMR`) labeled inline.
- `EVM_ASSETS_REQUIRING_ZERO_RESET_APPROVAL` marker exported (declarative only).
- New `solana/solana_tokens.ts`: SOLANA_USDC / EURC / WSOL / PYUSD / USDT + devnet variants.
- Barrel updates: `chain_ids` at root, `solana_tokens` in solana barrel.

**Additional behavioral changes shipped in this branch** (surfaced across review iterations 1-8, all Python-parity or documented safety measures):

- `networkTypeOf(chainId)` throws `ChainError(ChainNotSupported)` for unregistered negative chainIds (was silent EVM fallback). New non-throwing sibling `tryNetworkTypeOf(chainId): NetworkType | undefined` for callers that legitimately need totality.
- `registerNonEvmChain` throws `ChainError(InvalidArgument)` on family conflict (was last-writer-wins).
- Static seeds in `network_type.ts` for BTC (`-1/-2/-3`), Solana, TON, Tron families — routing works without any chain instance constructed.
- `btcParamsForChainId` throws `ChainError(ChainNotSupported)` (was bare Error); BTC params for `-1/-2/-3` are statically pre-seeded.
- `NetworkType.TRON` enum value added; `addressFor` fail-closes for TRON/COSMOS (was fall-through to EvmAddress); switch is exhaustive.
- `Token.strictEquals(other)` (includes decimals) and `Token.sameAsset(other)` (identifier-only) helpers.
- `EvmToken` constructor normalizes `identifier` to EIP-55 checksum (breaking for consumers persisting a specific casing).
- `requiresZeroResetApproval(token)` predicate.
- `migrateLegacySolanaChainId(id)` helper (`-100/-101/-102` → `-2000/-2001/-2002`); legacy IDs deliberately NOT registered as aliases (fail-closed).
- `SolanaChain.legacyRpcEnvNames` init field (`SolanaMainnet` honors pre-rename `SOLANA_RPC_URL`).
- `IsAddress` decorator distinguishes `ChainNotSupported` from address-format errors in its message.
- `suggestGas` rewritten: single-percentile `eth_feeHistory` request, sort-then-p90 tip selection (Python parity), 2-gwei empty-reward fallback, RPC transport failure bubbles as `ChainError(RpcError)`, parse failure as `ChainError(TransactionDecodeFailed)`, no defensive `getFeeData` fallback. Legacy branch returns `gasPrice` only (matches `EvmGasPricing(gas_price=…)`); consumers dispatch signing on `supportsEip1559`.
- `MIN_GAS_PRICE_FLOOR` (0.05 gwei) clamps both branches — TS safety measure Python doesn't have.

### Excluded (Phase 3+ — follow-up branch)

- **Decimal amount type** in `createTransferUnsignedTransaction` (Python takes `Decimal`, TS still takes `bigint`).
- **TransactionStatus** split into lean base + `EvmTransactionStatus` / `SolanaTransactionStatus` / `UtxoTransactionStatus` subclasses.
- **balanceChanges** reshape from flat `BalanceChange[]` to nested `Map<wallet, Map<identifier, AssetBalanceChange>>`.
- **`verifyMessageSignature` removal** from `Chain` (Python puts on Wallet; TS has no Wallet layer in v0).
- **FeePriority** threaded into transfer builders as `priority?: Priority | AbstractGasPricing`.
- **Tests** update for the reshaped APIs.

## Verification approach

For every change: verified against `/tmp/omnichain-py/src/omnichain/**` and cross-referenced in the commit message. No hallucinated API — each pre-baked chain, token, and enum matches Python's source line-for-line.

## Acceptance

- Every existing consumer (pluton, depositron) still builds against this branch (breaking: chainId + Solana name changes documented in `INTEGRATOR_MIGRATION_v0.md`).
- No functional regressions on Category A behavior beyond the documented alignments.
- All new pre-baked constants match Python addresses / decimals / symbols exactly.

## Related

- Follow-up branch: `feature/sinan-py-parity-2` for architectural rewrites (Phase 3+).
- Tracking: `INTEGRATOR_MIGRATION_v0.md` (breaking-change catalog), `SINAN_OPEN_QUESTIONS.md` (TS deviations to raise with Sinan).
