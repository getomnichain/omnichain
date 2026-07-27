# Sinan omnichain-py parity — Phase 2B: Decimal amounts + FeePriority threading

## Context

Wave 2A landed the structural refactor: `TransactionStatus` per-network
subclass hierarchy, `AssetBalanceChange` with bigint source-of-truth,
`upsert` zero-net cleanup, registry hardening. Wave 2B closes the
remaining two agreed structural gaps against `omnichain-py`:

- Human-readable `Decimal` amounts on the balance-change value type
  and in the transfer builder (Python-parity `balance_change_hr` +
  `amount_hr`)
- Chain-agnostic `FeePriority` (SLOW/NORMAL/FAST) threaded through
  `create_transfer_transaction`, with optional per-chain explicit
  `GasPricing` override — matches Python's `GasPricingType =
  Union[FeePriority, AbstractGasPricing]` signature at
  `base/base.py:162`.

TON port is **explicitly out of scope**.

## Scope

### 1. `decimal.js` peer dep

Consumers must `npm install decimal.js` before pulling this branch.
Documented in `docs/UPGRADE_TO_V0_2B.md`. No path around the new dep —
`Decimal` is the source-of-truth type Python uses for
`balance_change_hr` and `amount_hr`, and Wave 2A deferred it precisely
to make this a coordinated install.

### 2. `AssetBalanceChange` — Decimal accessor + factory

Python (`base/base.py:239-258`):
- Constructor takes `balance_change_hr: decimal.Decimal, decimals: int`
- Computes `balance_change_mr = hr_to_mr(hr, decimals)` on construction
- Exposes both fields

TS today (Wave 2A): stores `balanceChangeMr: bigint` only; `Decimal`
was deferred.

Wave 2B change:
- **`get balanceChangeHr(): Decimal`** — lazy getter derived from
  `balanceChangeMr / 10^decimals`. bigint stays the source of truth
  (avoids decimal.js's 20-sig-digit default truncating 18-decimal
  amounts ≥ ~100 tokens). Python parity is achieved on the *read*
  surface; storage flip is intentional and documented in
  `SINAN_OPEN_QUESTIONS.md`.
- **`static fromHr(hr: Decimal | string, decimals: number)`** —
  mirror of Python's alternate construction path. Accepts a `Decimal`
  directly or a numeric string. Rounds via `Decimal.trunc()` matching
  Python's `hr_to_mr`.
- **`toString()`** switches to `balanceChangeHr.toFixed()` to avoid
  scientific notation on ≥ 21-digit amounts (decimal.js `toExpPos`
  default).

### 3. `FeePriority` alias

Python name is `FeePriority`; TS name is `Priority`. Add a `FeePriority`
re-export in `priority.ts` (identity alias — no rename) so consumers
can write Python-parity code without a shim. `Priority` stays exported
for back-compat.

### 4. `AbstractGasPricing` base + per-chain subclasses

Python (`base/base.py:141-162`):
- `AbstractGasPricing(pydantic.BaseModel)` — abstract chain-specific
  explicit-fee override with `chain_type: ClassVar[ChainType]`
- Per-chain subclasses: `EvmGasPricing`, `SolanaGasPricing`,
  `UtxoGasPricing`, etc.
- `GasPricingType = Union[FeePriority, AbstractGasPricing]`

TS Wave 2B change:
- **`AbstractGasPricing`** abstract class in a new
  `abstract_gas_pricing.ts` with `readonly networkType: NetworkType`.
- **`EvmGasPricing`** in `evm/`: optional `gasPrice: bigint`, optional
  `maxFeePerGas: bigint`, optional `maxPriorityFeePerGas: bigint`.
  Validates 1559 vs legacy exclusivity at construction (mirrors the
  `EvmGasEstimate` discriminant from Wave 2A). Mirror of Python's
  `EvmGasPricing` at `impl/evm/base.py`.
- **`SolanaGasPricing`** in `solana/`: `priorityFeeMicroLamports:
  bigint`, optional `computeUnitLimit: bigint`.
- **`UtxoGasPricing`** in `utxo/`: `satsPerVByte: number`.
- **`GasPricingType = FeePriority | AbstractGasPricing`** union type
  exported from `priority.ts`.

### 5. `CreateTransferRequest` extensions

Current TS (Wave 2A):
```ts
interface CreateTransferRequest {
  from?: string;
  to: string;
  tokenIdentifier?: string;
  amount: bigint;
  memo?: string;
}
```

Wave 2B additions (Python parity):
```ts
interface CreateTransferRequest {
  from?: string;
  to: string;
  tokenIdentifier?: string;
  amount?: bigint;          // minor units (either amount OR amountHr)
  amountHr?: Decimal;       // human-readable (Python `amount_hr`)
  isFullBalance?: boolean;  // Python `is_full_balance`, default false
  gasPricing?: GasPricingType;  // Python `gas_pricing`, defaults to FeePriority.NORMAL
  memo?: string;
}
```

Validation: exactly one of `{amount, amountHr, isFullBalance}` must
be supplied — enforced in each chain's `createTransferUnsignedTransaction`
so consumers get a `ChainError(InvalidArgument)` on ambiguous input.

### 6. Wire amount resolution through the transfer builders

**EvmChain + SolanaChain** consume the new `amount / amountHr /
isFullBalance` contract via `resolveTransferAmount`. Native path uses
`_nativeToken.decimals`; SPL/ERC-20 path resolves decimals via the
existing `resolveMintDecimals` / `resolveErc20DecimalsDefensive`.
`isFullBalance` requires an explicit `from` and fetches
`getBalance(from, tokenIdentifier)`.

**UTXO** does NOT consume the new fields in Wave 2B — the multi-
recipient `outputs[]` form has its own semantics that need a separate
design pass. Recorded in the mid-flight deviations section.

**`gasPricing` field is on the base interface but per-chain builders
do NOT wire it in Wave 2B.** The existing per-chain option fields
(`priorityFeeMicroLamportsPerCu` + `computeUnitLimit` on Solana;
`feeRateSatsPerVByte` + `feeTargetBlocks` on UTXO; EVM builder options
on `UnsignedEvmTransaction`) continue to work. Full `gasPricing`
handling per-chain is a Phase 2 follow-up card — the type surface is
in place, the wiring lands with the next card that touches those code
paths. Documented in `docs/UPGRADE_TO_V0_2B.md` under "Not yet wired".

### 7. `EvmParsedTransactionLog.isTransferLog / asTransferLog + EvmErc20TransferLog`

Deferred from Wave 2A card §3b. Small (~40 LoC) — implement here so
the value type isn't a passive placeholder any more. Method bodies
extract from the private parser in `evm_chain.ts:614-629` and export
the shared helper.

## Scope changes accepted mid-flight

Documented so the card matches what ships. Each was flagged during
the review cycle and confirmed with the user or defensibly deferred:

- **§6 `isFullBalance` wiring on EVM + SolanaChain — REJECTED at
  entry instead of implemented.** The card originally said
  "`isFullBalance` requires an explicit `from` and fetches
  `getBalance(from, tokenIdentifier)`". Iter-1 review flagged that
  sending `value = balance` on the native path guarantees
  insufficient-funds (leaves 0 for gas / base-fee / rent). Wiring
  the fee-reserve subtract (`balance - estimated_fee`) is non-
  trivial per chain and requires the `suggest*` estimator wired at
  the builder — which is itself deferred (see next). Both EVM and
  Solana therefore throw `ChainError(InvalidArgument)` for
  `isFullBalance: true` in Wave 2B. Follow-up card lands the sweep
  with fee-reserve.

- **§6 `gasPricing` wiring on all three builders — REJECTED at
  entry instead of implemented.** The card originally said each
  builder resolves `FeePriority` via its `suggest*` estimator or
  uses `AbstractGasPricing` fields directly. Iter-1 review flagged
  that the existing builders don't set gas fields on the returned
  `UnsignedTransaction` at all — the caller populates those
  externally. Wiring means changing the builder shape substantially
  per chain. All three builders throw `ChainError(InvalidArgument)`
  for `gasPricing !== undefined`, and the `CreateTransferRequest`
  JSDoc says so explicitly. The type surface (`AbstractGasPricing`
  + subclasses + `GasPricingType` union + `isAbstractGasPricing`
  runtime guard + `FeePriority` alias) ships as-is for consumer
  code that wants to construct these values ahead of the wiring
  card.

- **Zero-amount policy tightened to `> 0` on the existing
  `amount: bigint` path.** Pre-Wave-2B, `EvmChain.createTransferUnsignedTransaction`
  passed `amount: 0n` straight through to `value: 0n` /
  `transfer(to, 0)`. Iter-1 unified the check inside
  `resolveTransferAmount` so EVM + Solana reject zero uniformly (UTXO
  enforces its own > 0 + dust checks in `UtxoChain.buildTransfer` since
  it doesn't route through `resolveTransferAmount`; all UTXO
  validation errors carry `ChainErrorKinds.InvalidArgument` for
  cross-chain narrowing symmetry).
  Behavior change vs `main` on EVM. Recorded here + in
  `docs/UPGRADE_TO_V0_2B.md` under the "Contract" description.

- **§7 `EvmParsedTransactionLog.asTransferLog` — decoder NOT rewired
  to consume the class method.** The card asked for "the shared
  helper" so both the receipt-decoder in `evm_chain.ts` and the
  public `asTransferLog()` accessor go through one parser. Only
  the `ERC20_TRANSFER_TOPIC` topic0 constant was shared; the
  decoder loop still inlines its own `slice(26)` + `BigInt(data)`
  parse (lenient — skips malformed logs), while `asTransferLog()`
  is strict (throws on wrong length). Deferred to a follow-up
  because rewiring the decoder requires deciding whether
  `NestedBalanceChanges` should silently drop non-standard-log
  entries or surface them as `TransactionDecodeFailed` — a policy
  decision that touches every consumer. Doc comments in
  `evm_transaction_status.ts` and `docs/UPGRADE_TO_V0_2B.md` no
  longer claim "one parser".

## Out of scope

- **TON port** (`impl/ton/base.py` ~1700 lines) — explicitly dropped
  per user directive
- **`UtxoTransactionInput`** value type + input-side accounting —
  needs `UtxoRawTransactionProvider` surface widening; defer to a
  separate provider-refactor card
- **`SolanaTransactionSimulationFees`** for `simulate_transaction` —
  simulation path itself not ported yet
- All Wave 2A non-critical mediums the reviewer flagged (UTXO 404
  narrowing, sanitizer consolidation, EVM Pending-on-tx-null
  diagnostic distinction) — file as separate follow-ups

## Docs

- `docs/UPGRADE_TO_V0_2B.md` (committed) — consumer migration:
  - `npm install decimal.js`
  - `AssetBalanceChange.balanceChangeHr` accessor + `fromHr` factory
  - `CreateTransferRequest` new fields with validation contract
  - `FeePriority` alias + per-chain `GasPricing` overrides
  - grep targets for consumer teams
- `docs/README.md` update: `AssetBalanceChange` row gains the Decimal
  accessor; new `GasPricing` row
- `SINAN_OPEN_QUESTIONS.md` (gitignored): document the bigint-storage
  flip vs Python's hr-storage (unchanged from Wave 2A; make sure the
  entry accurately says the accessor now exists)

## Verification approach

- Iterative `code_reviewer.py` cycles (Python-parity rubric — Sinan
  is the source of truth, deviations must be documented in the
  card's "Scope changes accepted mid-flight" section)
- Terminal stop when no criticals — same policy as Waves 1 + 2A
- New tests:
  - `AssetBalanceChange` Decimal round-trip (fromHr → balanceChangeMr,
    balanceChangeHr → toString)
  - `EvmParsedTransactionLog.isTransferLog / asTransferLog` per shape
    (correct, wrong topic-count, wrong topic0, malformed data)
  - `CreateTransferRequest` validation matrix (amount alone, amountHr
    alone, isFullBalance alone, all-three throws, none throws)
  - `AbstractGasPricing` + subclass constructors (1559-vs-legacy
    exclusivity on EvmGasPricing)
  - Chain-level `createTransferUnsignedTransaction` accepting each
    of `FeePriority.SLOW/NORMAL/FAST` and an explicit GasPricing
