# Sinan omnichain-py parity — Phase 2A: structural refactors + iter-15 mediums

## Context

Follows `feature/sinan-py-parity` (merged as PR #8). Phase 2 is split into three
independent PRs so review stays tractable:

- **2A (this branch)** — surface refactors + iter-15 hardening, no new features
- **2B** — `FeePriority` threading + `AssetBalance` decimal accessor
- **2C** — TON port (~1,700 lines Python → TS)

Every change here has a specific line in `omnichain-py/base/base.py` or
`omnichain-py/impl/**/base.py` that it mirrors. Deviations are called out
inline and land in `SINAN_OPEN_QUESTIONS.md` for upstream discussion.

## Scope (Wave 2A)

### 1. Remove `verifyMessageSignature` from `Chain` base

**Python:** absent — `grep -r verify_message_signature omnichain-py/` returns
zero matches. The TS `Chain` base has it as `abstract`; removal restores
parity.

**Change:**
- Delete `verifyMessageSignature` abstract from `chain.base.ts`
- Delete `VerifyMessageSignatureRequest` type
- Delete concrete impls on `EvmChain`, `SolanaChain`, `BtcChain`, `UtxoChain`,
  `TonAddress`-adjacent helpers
- Delete the `verify_message_signature.spec.ts` suites
- Delete barrel exports for the removed types

**Consumer impact:** breaking. Documented in `docs/UPGRADE_TO_V0_2A.md` —
consumers relying on it must move to `ethers.verifyMessage` /
`nacl.sign.detached.verify` / `bitcoinjs-message` directly, matching what
`omnichain-py` consumers already do.

### 2. `TransactionStatus` variant-shape refactor (Python parity)

**Python (base/base.py:361-399):** single `AbstractTransactionStatus` class;
`balance_changes`, `error`, `inclusion_datetime_utc` are all `Optional` and
gated by runtime asserts on `status_type`. Not per-network subclasses.

**Change:**
- `TransactionStatus` becomes a single class (or interface + factory) with:
  - `status: TransactionStatusType` (unchanged)
  - `balanceChanges: NestedBalanceChanges | null` (was `BalanceChange[]`)
  - `error: TransactionError | null` (new — folded from `errorInfo`)
  - `inclusionAt: Date | null` (renamed from `txTimestamp`)
- Runtime constructor asserts mirror Python's:
  - `Success`  → `balanceChanges` present, `error` null
  - `Failed`   → `balanceChanges` null,    `error` present
  - `Pending`  → both null
  - `NotFound` → both null (error optional per Python's "in not found, error can be available" comment)
- Type-guard helpers: `isSuccess(s)`, `isFailed(s)`, `isPending(s)`,
  `isNotFound(s)` — narrow the field types at call sites.
- `TransactionStatusTypes` (const object) → keep as-is (already correct).

**Deviation from Python (documented):** Python uses `AssertionError`; TS uses
`ChainError(InvalidArgument)` for consistency with the rest of the SDK.

### 3. Nested `balanceChanges` (Python parity)

**Python (base/base.py:239-311):** `AssetBalanceChange` value type with `pre`,
`post`, `decimals`. Container shape:
`Optional[Dict[WalletAddressType, Dict[AssetType, AssetBalanceChange]]]`.
`AssetBalanceChange.merge` handles adding a change into an existing
`(wallet, asset)` cell, and deletes the wallet row when its cells all zero out.

**Change:**
- New value type `AssetBalanceChange { pre: bigint; post: bigint; decimals: number }`
  with methods:
  - `static zero(decimals): AssetBalanceChange`
  - `static fromDelta(deltaMinorUnits, decimals): AssetBalanceChange`
  - `add(other): AssetBalanceChange` (Python `__add__`)
  - `delta(): bigint` (post - pre)
- New container type `NestedBalanceChanges = Map<string, Map<string, AssetBalanceChange>>`
  keyed by `(walletAddress, tokenIdentifier)`. `tokenIdentifier` for native is `''`
  matching current convention.
- Merge helper `mergeBalanceChange(container, wallet, tokenIdentifier, change)`
  mirrors Python's `AssetBalanceChange.merge`, including the "delete wallet
  row when empty" behavior.
- **Solana decoder rewrite:** `_decodeBalanceChanges` currently produces
  `BalanceChange[]` — rewrite to produce `NestedBalanceChanges`. Preserves
  the three PR #7 bug fixes (decimals from `uiTokenAmount`, drop null-owner
  entries, `UNKNOWN_<prefix>` symbol).
- **EVM decoder rewrite:** parallel change to whatever produces the flat
  array today.

### 4. iter-15 mediums

Small, mechanical hardening — one commit per, easy to review.

4a. **`UtxoChain` constructor BTC-ID guard.** Refuse
`CHAIN_ID_BITCOIN_MAINNET / TESTNET / SIGNET` when
`init.params.name` is not a BTC network. Prevents an LTC chain constructed
with `chainId: -1` from validating BTC addresses via the seeded params.
Mirrors the guard we already added on `EvmChain`.

4b. **`registerBtcChainParams` static-seed protection.** Refuse
re-registration of the three statically-seeded chainIds outright. Consumer-
registered ids keep the current name-conflict check, upgraded to compare
identity-relevant fields (`hrp`, `pubKeyHash`, `scriptHash`, `bip32`).

4c. **`registerNonEvmChain` integer guard.** Add `Number.isInteger(chainId)`
check at the top; reject `NaN`, `Infinity`, non-integers at the registration
point rather than at first `networkTypeOf` call.

4d. **`unregisterChain` paired BTC-params cleanup.** Also delete
`btcParamsByChainId[chainId]` when the removed network was BTC. Prevents the
two registries from drifting.

4e. **`EvmGasEstimate` discriminant.** Add `kind: 'legacy' | 'eip1559'` to
the estimate type. Legacy path returns `{kind: 'legacy', gasPrice}`; 1559
path returns `{kind: 'eip1559', maxFeePerGas, maxPriorityFeePerGas}`. Removes
the "consumer must dispatch on `chain.supportsEip1559`" footgun called out in
iter 15 medium #4.

## Out of scope for 2A (goes to 2B / 2C)

- FeePriority threading through `CreateTransferRequest` → **2B**
- `AssetBalance` type with human-readable Decimal accessor + `decimal.js` dep → **2B**
- TON `impl/base.py` port (~1,700 lines) → **2C**

## Docs

- `docs/UPGRADE_TO_V0_2A.md` (new, committed) — consumer migration:
  - `verifyMessageSignature` removal + workarounds
  - `TransactionStatus.balanceChanges` shape change: `BalanceChange[]` →
    `NestedBalanceChanges | null` — includes iteration snippets
  - `EvmGasEstimate` discriminant — dispatch pattern
  - Registry hardening (guard rejections consumer might hit)
- `docs/README.md` — update TransactionStatus + BalanceChange sections
- `SINAN_OPEN_QUESTIONS.md` (gitignored) — add: "Should `AssertionError` in
  `AbstractTransactionStatus.__init__` be a domain-specific error type for
  consumer catchability? TS uses `ChainError(InvalidArgument)`."

## Verification approach

- Run existing 135/135 jest suite green after each Wave (2A → 2B → 2C order)
- Iterative `code_reviewer.py` cycles per prior discipline
- Terminal stop when no criticals — same policy as Phase 1
- Barrel export diff `main` → branch: only additions + documented removals

## Coordination critical (external)

- `verifyMessageSignature` removal breaks any consumer calling it directly.
  Grep target for consumer teams: `\.verifyMessageSignature\(`. Documented in
  `docs/UPGRADE_TO_V0_2A.md`.
- `TransactionStatus.balanceChanges` shape change breaks anyone reading the
  flat array. Grep target: `\.balanceChanges\[|\.balanceChanges\.map\(|for .* of .*\.balanceChanges`. Documented.
