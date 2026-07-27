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

### 2. `TransactionStatus` per-network subclass hierarchy (Python parity)

**Python:** `AbstractTransactionStatus` (base/base.py:361-399) is an abstract
base with 5 core fields + runtime asserts, and each impl subclasses it to
add chain-specific extras:
- `EvmTransactionStatus(AbstractTransactionStatus)` — adds `logs`, `fees`
- `SolanaTransactionStatus(AbstractTransactionStatus)` — adds `fees`
- `UtxoTransactionStatus(AbstractTransactionStatus)` — adds `outputs`,
  `vsize`, `confirmations`, `fees` (an SDK addition vs Python's UTXO
  base for surface parity with EVM/Solana); constructor param
  `confirmation_datetime_utc` is aliased to parent's `inclusion_datetime_utc`.
  Python's `inputs` field is deferred until the raw-tx provider surface
  carries per-input address/value.

Static factories `successful` / `failed` / `pending` / `not_found` live on
each subclass (they need the chain-specific fields). `UtxoTransactionStatus`
has **no** factories; direct constructor. `EvmTransactionStatus.not_found`
requires positional `error`; `SolanaTransactionStatus.not_found` defaults it
to `None` — mirrored per-subclass exactly.

**Change:** abstract `TransactionStatus` base (transaction_status.ts) with
5 core fields `{chainId, status, inclusionAt, error, balanceChanges}` and
constructor asserts:
- `Success`  → `balanceChanges` non-null, `error` null
- `Failed`   → `balanceChanges` null, `error` non-null
- `Pending`  → both null (`{}` for balanceChanges also fails — must be exactly null)
- `NotFound` → `balanceChanges` null, `error` optional

Three subclass modules (`evm/evm_transaction_status.ts`,
`solana/solana_transaction_status.ts`, `utxo/utxo_transaction_status.ts`)
each add the chain-specific value types and factories.

Type-guard helpers `isSuccess`/`isFailed`/`isPending`/`isNotFound` narrow
nullness at consumer call sites.

**Deviation from Python (documented in SINAN_OPEN_QUESTIONS):** Python
uses `assert` → `AssertionError`; TS uses `ChainError(InvalidArgument)` for
consistency with the rest of the SDK. TS uses exhaustive switch on the
status type discriminant so a new status is a compile error (Python falls
through to Pending).

### 3. `AssetBalanceChange` + `NestedBalanceChanges` (Python parity + safety flip)

**Python (base/base.py:239-311):** value type with `_decimals: int`,
`balance_change_hr: Decimal`, `balance_change_mr: int` (computed
`hr_to_mr(hr, decimals)` in constructor). Static `upsert(dict, wallet,
asset, change)` — mutating; zero-net collapses BOTH the asset row and the
wallet row when its inner dict empties; on non-zero-net merge uses
`change._decimals` (not existing's).

Container: `Dict[WalletAddressType, Dict[AssetType, AssetBalanceChange]]`.
Asset keys are objects hashed via `AbstractAsset._hash_str = f'{chainId}_{symbol}_{identifier or ""}_{decimals}'`.

**Change:**
- `AssetBalanceChange {balanceChangeMr: bigint, decimals: number}` with
  `balanceChangeHr: Decimal` as a **lazy getter** derived from mr / 10^decimals.
  Storage flip vs Python (which stores hr and computes mr): decimal.js
  defaults to 20 significant digits, so 18-decimal amounts ≥ ~100 tokens
  silently truncate on Decimal → bigint round-trip. Storing bigint keeps
  every wei/lamport/satoshi exact; Decimal accessor is best-effort display.
- Statics: `zero(decimals)`, `fromMr(mr, decimals)`, `fromHr(hr, decimals)`,
  `upsert(container, wallet, token, change)` (mutating, Python-parity zero-
  net cleanup + decimals mismatch throws).
- `add(other)` requires decimals-equal; throws otherwise.
- `NestedBalanceChanges = Map<walletStr, Map<assetHash, {token, change}>>`
  where `assetHashOf(token) = ${chainId}_${symbol}_${identifier ?? ''}` —
  drops decimals from the key (matches `Token.equals` identity). Python
  includes decimals in `__hash__` and excludes from `__eq__` — a wart TS
  fixes here to prevent decimals-disagreement splitting one asset into
  two non-cancelling rows on Solana `uiTokenAmount.decimals` variance.
- **Solana decoder** (`_decodeBalanceChanges`) rewritten to return
  `NestedBalanceChanges` via `upsert`. Preserves the three PR #7 bug fixes.
- **EVM decoder** (`decodeBalanceChanges`) rewritten to return
  `NestedBalanceChanges` via `upsert`. Signature gains required `gasCost`
  arg (sender native debit = value + gasCost — Python parity). Native +
  ERC-20 self-transfers add both legs unconditionally so upsert's zero-
  net rule cancels the intra-token movement while preserving gas debit.
- **UTXO decoder** (`getTransactionStatus`) rewritten. Outputs-only
  behavior preserved from Phase 1 (input-side accounting parity deferred;
  noted in `SINAN_OPEN_QUESTIONS.md`).

### 3b. Per-network value types

Ported 1:1 from Python:
- `EvmTransactionGasFees` — `gasLimit`, `gasLimitUsed`, `effectiveGasPrice`
  (all `bigint`, `>= 0` — observed data, not user input), optional
  `gasPrice` / `maxFeePerGas` / `maxPriorityFeePerGas`; computed
  `totalGasInWei = gasLimitUsed * effectiveGasPrice`.
- `EvmParsedTransactionLog` with `isTransferLog()` + `asTransferLog()` →
  `EvmErc20TransferLog { tokenContract, fromAddress, toAddress, value }`.
- `SolanaTransactionFees` — `feePayer`, `feeLamports >= 0`,
  `computeUnitsConsumed: bigint | null` (getTransaction may omit it in
  older meta shapes; fabricating a value would misrepresent observed
  data), `netLamportsChangeByFeePayer` (may be `<= 0`).
- `SolanaTransactionStatus.balanceChangesExcludingFees(nativeAsset)` —
  deep-copies and reverses the fee debit on the `feePayer`'s native row.
  Validates that the passed `nativeAsset` matches the recorded row via
  `assetHashOf` — throws instead of producing a phantom second native row.
- `UtxoTransactionInput / UtxoTransactionOutput` value types
  (txid/vout/scriptPubkeyHex/address/value; scriptPubkeyHex/address/value).
- `UtxoTransactionStatus.confirmationAt` constructor param aliased to
  parent's `inclusionAt`, exposed as a getter for consumer readability.

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
- TON `impl/base.py` port (~1,700 lines) → **2C**

## Scope changes accepted mid-flight (vs the original card outline)

- **`decimal.js` deferred back to Wave 2B.** Wave 2A ships
  `AssetBalanceChange` with **`balanceChangeMr: bigint` only** — no
  `Decimal` accessor, no `fromHr` factory. The Python-parity
  `balance_change_hr: Decimal` returns in 2B alongside `FeePriority`
  threading, when the consumer `npm install decimal.js` PRs land in
  the same train. This avoids the coordination-critical of shipping a
  new peer dep in 2A. `UtxoTransactionInput`/`UtxoTransactionOutput`
  use `valueSats: bigint` for the same reason. Final-state parity
  with Sinan is achieved at 2B, not at 2A.
- **`TransactionStatus` split into per-network subclasses** rather than a
  single class — Python actually does this (each impl subclasses
  `AbstractTransactionStatus` to add chain-specific fields). "Match the
  python" directive wins over the original single-class sketch.
- **`AssetBalanceChange`: `upsert` (not `merge`), bigint source-of-truth,
  `fromMr`/`zero` factories (no `fromHr`, no `delta()`)** — mirrors
  Python's method name and defers the Decimal-typed factory to 2B.
- **`add()` and `upsert()` do not throw on decimals mismatch** — Python's
  `__add__`/`upsert` don't check either. The newer change's decimals
  silently win on merge (Python `change._decimals`). Consumers with a
  decimals-consistency requirement enforce it externally.
- **`NestedBalanceChanges` keyed by `assetHashOf(token)` = `${chainId}_${identifier ?? ''}`**
  (drops both `symbol` and `decimals` from the hash key). `symbol` is
  RPC-derived (Python parity here would key on `sameAsset` identity
  anyway); on EVM `resolveErc20TokenDefensive` falls back to
  `UNKNOWN_<hex>` when `contract.symbol()` fails, so a symbol-based key
  would produce different keys for the same asset across transient RPC
  health. `decimals` exclusion mirrors the same reasoning (Solana
  `uiTokenAmount.decimals` variance). Deviation from Python's
  `AbstractAsset.__hash__` (which is `chainId_symbol_identifier_decimals`)
  is intentional — Python's `__hash__` and `__eq__` disagree, a known
  upstream wart; TS keys on `Token.sameAsset` identity to keep dict
  lookups consistent.
- **UTXO `getTransactionStatus` narrows the `try` to the provider call
  only** — transport failures throw `ChainError(RpcError)` (with
  sanitized reason), constructor/upsert throws propagate, only "no such
  tx" from the provider returns `NotFound`. Prevents the iter-1
  fail-open where every failure surfaced as NotFound.
- **`SolanaTransactionStatus.failed` accepts `fees: null`** for the
  settled-but-unfetchable path (`getSignatureStatus` reports finalized
  + err, but `getTransaction` returned null — fees are not
  reconstructable). Prevents indefinite Pending polling on settled
  failures.
- **`SolanaChain.getTransactionStatus` returns Pending on `tx.meta === null`**
  (a valid RPC response shape) rather than throwing. Matches the
  `_decodeBalanceChanges` guard that was already in place.
- **`balanceChangesExcludingFees` handles absent fee-payer row via upsert**
  (creates a fresh +feeLamports entry) instead of throwing. Fixes the
  legitimate-tx case where the fee payer's net native delta was exactly
  zero (dropped by the decoder's `delta === 0n` filter).
- **`EvmGasEstimate` fee validators accept `>= 0`** — subsidised chains
  and devnets report zero prices; symmetric with `EvmTransactionGasFees`.
- **`UtxoTransactionStatus.fees` field added** (with `absoluteSats` +
  `vsize`; UTXO Python omits this but TS surface parity with EVM/Solana
  keeps the consumer's deposit detector uniform — documented deviation
  in SINAN_OPEN_QUESTIONS).
- **`btcParamsShapeMatches` exported and shared** by
  `registerBtcChainParams` and `UtxoChain`'s reserved-id guard so both
  sites enforce one invariant with the same field set.

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
