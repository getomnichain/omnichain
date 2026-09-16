---
id: RIN-226
title: omnichain — surface UTXO transaction inputs and net per-address balance changes on UtxoTransactionStatus
status: draft
repos: [omnichain]
---

<!-- ======================= PART A - REQUEST ======================= -->

# Summary

`UtxoTransactionStatus` reports who **received** in a Bitcoin transaction and
nothing about who **paid**: `balanceChanges` are gross output credits per
address, and `inputs` is not surfaced at all ("comes back in the 2C UTXO port").
Every consumer that needs the paying side has built its own answer. Rango
Intents (BTC-8) fetches every input's parent transaction to learn the funding
addresses — one Esplora round-trip per distinct parent, bounded, and treated as
transient when incomplete. Clydner's BlockCypher parser computes net
per-address deltas from the raw payload. The SDK, Rango Intents and Clydner
therefore hold three definitions of "what this transaction did to each
address", and they disagree whenever an address appears on both sides. This
task makes the TS SDK match the Python SDK's already-shipped design: surface
resolved `inputs[]` on the status, add a `UtxoTransaction` intermediate type
that carries the pre-computed net-per-address map, and make
`UtxoTransactionStatus.balanceChanges` net (from that map). Every hydration
detail lives in the per-tool provider, exactly as Python does it.

---

# Objective

When the system reads a Bitcoin transaction, it must know two things: who was
paid, and who paid. The shared library only reports the first. Because of this,
two of our services each wrote their own code to find the second, and the two
answers do not always agree. After this task the library reports both, in one
place, in a way that matches how it already reports Ethereum and Solana
transactions — and in a way that matches the Python SDK for BTC — so services
can delete their own versions.

---

# Scope

## Out of scope / non-goals

- No new SDK code path that computes inputs at the *SDK* layer. Hydration lives
  in each `UtxoRawTransactionProvider` implementation, matching Python's
  `AbstractUtxoTool.get_tx` — the SDK receives an already-hydrated
  `UtxoTransaction` from the tool and does not walk prevouts itself.
- No consumer change in this card. rango-intents and Clydner follow-ups are
  listed under Dependencies and are filed separately after this ships.
- No change to `outputs`, `vsize`, `fees` or `confirmations` on the status.
- No change to `getTransactionStatus`'s public signature; Litecoin and Dogecoin
  inherit the new behaviour through `UtxoChain` and are covered by the generic
  tests, not by new per-coin fixtures.
- No inscription/rune/rare-sat annotation on inputs.
- No change to the Python SDK. Python already has this shape; TS is catching
  up.

---

# Requirements

- **R1. `UtxoTransaction` intermediate type.** A new type mirroring Python's
  `class UtxoTransaction`:
  ```
  interface UtxoTransaction {
    inputs: readonly UtxoTransactionInput[];
    outputs: readonly UtxoTransactionOutput[];
    netChangesHr: Readonly<Record<string, Decimal>>;
    size: number;
    vsize: number;
    confirmations: number;
    confirmationDatetime: Date | null;
  }
  ```
  Exported from `utxo/utxo.ts`. Produced by every `UtxoRawTransactionProvider`
  implementation via a new `getTransactionWithInputs(txid): Promise<UtxoTransaction>`
  method (see R4). `netChangesHr` is keyed by address and expresses BTC (not
  sats) as `Decimal`, matching Python's `net_changes: Dict[str, Decimal]`.

- **R2. `UtxoTransactionInput` shape — dual units for transition.**
  ```
  interface UtxoTransactionInput {
    txid: string;
    vout: number;
    scriptPubkeyHex: string;
    address: string | null;
    /** @deprecated Migrate to `valueBtcHr` before the next major. */
    valueSats: bigint;
    valueBtcHr: Decimal;
    coinbase?: true;
  }
  ```
  Both `valueSats` and `valueBtcHr` are populated on every input this release.
  The `valueSats` field is JSDoc-`@deprecated`; a future major release drops it
  and renames `valueBtcHr` → `value` to align with Python's `Decimal` shape.
  This mirrors the `AssetBalanceChange.balanceChangeMr`/`Hr` idiom already in
  the SDK.

- **R3. Inputs surfaced on the status.** `UtxoTransactionStatus` gains
  `inputs: readonly UtxoTransactionInput[] | null`, populated from the tool's
  `UtxoTransaction.inputs`. `null` means the SDK could not resolve the set
  (see R5), never "no inputs".

- **R4. Provider contract change — tools hydrate.**
  `UtxoRawTransactionProvider` gains
  `getTransactionWithInputs(txid: string): Promise<UtxoTransaction>` alongside
  the existing `getTransaction`. Each adapter is responsible for hydrating per
  its own API — same pattern as `impl/utxo/tools/bitcoin_core.py:get_tx` and
  `impl/utxo/tools/blockcypher.py:get_tx`. No SDK-side walker.
  - **Esplora / Blockstream** — parse `vin[*].prevout.{value, scriptpubkey_address}`
    which the provider already returns in its `/tx/{txid}` response; zero extra
    RPCs.
  - **Bitcoin-Core** — call `getrawtransaction verbose=2` (Core ≥ 25.0) for the
    inline prevout path (zero extra RPCs), else loop
    `getrawtransaction verbose=1` per distinct parent (N extra RPCs, matching
    what Python's `bitcoin_core.py:get_tx` does today at line 453). One config
    flag on the adapter selects which mode.
  - **Unisat** — loop the adapter's per-vout endpoint per distinct parent.
    N extra RPCs. Deposit-detector call sites unaffected because those go
    through `outputs[]`, not through the new hydrated path.

- **R5. Partial failure is explicit.** If a tool's `getTransactionWithInputs`
  cannot resolve every input (any prevout fetch failed for the Bitcoin-Core
  fallback, or the tool's response was missing `prevout` data), the status
  carries `inputs: null` and
  `inputsUnresolvedReason: 'provider_error' | 'parent_missing' | 'pending'`;
  it does not throw, and it does not return a partial array a consumer could
  mistake for complete.

- **R6. Coinbase and unresolvable inputs.** A coinbase input (all-zero
  `prevout.txid`, `vout 0xffffffff`) yields
  `{ coinbase: true, address: null, valueSats: 0n, valueBtcHr: Decimal(0),
  scriptPubkeyHex: '' }`. A parent output whose script has no address (bare
  script, OP_RETURN) yields `address: null` with the script hex retained on
  `scriptPubkeyHex`.

- **R7. Balance changes are net (breaking).**
  `UtxoTransactionStatus.balanceChanges` on a `Success` status is derived from
  the tool's `UtxoTransaction.netChangesHr`, so it debits each input's value
  from its address and credits each output's — an address on both sides shows
  its net delta, matching `EvmTransactionStatus`, `SolanaTransactionStatus`,
  Python's UTXO status, and Clydner's BlockCypher parser. When inputs are
  unresolved (R5), `balanceChanges` is `null` rather than a gross map
  presented as net.
  - **No `outputCreditsByAddress()` accessor and no
    `grossOutputCreditsLegacy` softener.** Python doesn't have either. Deposit
    detectors that only need gross output credits per address iterate
    `status.outputs[]` directly, which is already on the class.

- **R8. Pending transactions.** A `Pending` status keeps `balanceChanges: null`
  (existing invariant) and may carry `inputs` if the mempool provider exposes
  them; if not, `inputs: null` with `inputsUnresolvedReason: 'pending'`.

- **R9. Published contract.** The change to `balanceChanges` semantics on UTXO
  is a breaking change for any consumer that summed positive credits: it ships
  with a version bump, a `CHANGELOG.md` entry naming the shape flip, and an
  `INTEGRATOR_MIGRATION_v0.md` note showing the `outputs[]` iteration pattern
  as the replacement. The class doc's "gross output credits" caveat at
  `utxo_transaction_status.ts:90-101` is rewritten.

- **R10. Consumer-companion DoD (Definition-of-done).** Two companion task
  cards are filed and at least `ready` before this card is marked `done`:
  a rango-intents card for BTC-8 (delete `enrichInputTxFromChain` and the
  parent-tx resolver; consume `status.inputs` and iterate `status.outputs[]`
  for deposit detection) and a Clydner card (drop the parser's own netting
  in favour of the SDK's, or document why it keeps its own because it
  ingests BlockCypher payloads directly, not SDK statuses).

---

# Acceptance Criteria

Fixtures are `UtxoTransaction` values a `UtxoRawTransactionProvider` stub
returns from `getTransactionWithInputs`; amounts in sats.

- **AC1 (R3)** A tx with two inputs from `A` (`50_000`, `30_000`) and outputs
  `B: 70_000`, `A: 9_000` (change) resolves `inputs` on the status to two
  entries with `address: A`, `valueSats: 50_000n`/`30_000n`,
  `valueBtcHr: Decimal('0.00050000')`/`Decimal('0.00030000')`,
  `scriptPubkeyHex` set, in `vin` order.

- **AC2 (R7)** The same tx yields `balanceChanges`: `A: -71_000_sats-hr`,
  `B: +70_000_sats-hr`; the `1_000` gap is the fee and is not attributed to
  any address.

- **AC3 (R7, self-send)** A tx whose only input is from `D` and whose only
  output is to `D` yields `balanceChanges: { D: -fee_hr }` — the case that
  today reads as a large gross credit with an unchanged balance.

- **AC4 (R7, no accessor)** `UtxoTransactionStatus` exposes no
  `outputCreditsByAddress()` method and no `grossOutputCreditsLegacy` field.
  A deposit detector that needs gross credits reads `status.outputs[]`
  directly.

- **AC5 (R4, esplora)** A stub `EsploraTool` that returns
  `vin[*].prevout.{value, scriptpubkey_address}` inline observes exactly one
  HTTP call to `getTransactionWithInputs` — no extra parent fetches.

- **AC6 (R4, bitcoin-core verbose=2)** A stub `BitcoinCoreTool` in
  `verbose=2` mode observes one `getrawtransaction` call for the whole tx.

- **AC7 (R4, bitcoin-core verbose=1 fallback)** A stub `BitcoinCoreTool` in
  `verbose=1`-fallback mode on a tx with 10 inputs across 3 distinct parents
  observes exactly 4 RPCs (`1 main + 3 parents`). Duplicates are de-duped.

- **AC8 (R5)** A stub whose main call succeeds but whose parent fetch fails
  (in `verbose=1` fallback or Unisat mode) yields status.`inputs === null`,
  `status.inputsUnresolvedReason === 'provider_error'`, and
  `status.balanceChanges === null`; nothing throws; the underlying error is
  attached as `cause` on the status's diagnostic.

- **AC9 (R6, coinbase)** A coinbase tx yields exactly one input with
  `coinbase: true, address: null, valueSats: 0n, valueBtcHr: Decimal(0)`;
  `balanceChanges` credits the miner output only.

- **AC10 (R6, opreturn parent)** A parent output that is `OP_RETURN` yields
  `address: null` with its `scriptPubkeyHex`; it contributes no debit.

- **AC11 (R8)** A `Pending` status has `balanceChanges: null`; `inputs` is
  either resolved or `null` with `inputsUnresolvedReason: 'pending'`;
  existing pending tests pass.

- **AC12 (R2)** `UtxoTransactionInput.valueSats` is JSDoc-`@deprecated`.
  Both `valueSats` and `valueBtcHr` are populated on every entry this
  release; `Decimal(valueSats).div(1e8).equals(valueBtcHr)` holds.

- **AC13 (R9)** `package.json` version bumped per the repo's semver policy
  for a breaking change (`balanceChanges` shape flip); `CHANGELOG.md` and
  `INTEGRATOR_MIGRATION_v0.md` mention the `outputs[]`-iteration replacement
  for deposit detection; the doc comment on `UtxoTransactionStatus` no
  longer says "consumers doing uniform cross-chain balance reconciliation
  must special-case UTXO".

- **AC14 (R10)** Two companion cards exist, linked from this card by
  YouTrack id: one on rango-intents (delete `enrichInputTxFromChain` and
  BTC-8 parent-tx resolver), one on Clydner (drop or justify keeping the
  BlockCypher parser's own netting). Both at least `ready` before this
  card moves to `done`.

- **AC15 (R1–R8)** The existing `UtxoChain.getTransactionStatus` tests for
  LTC and DOGE pass with the generic fixtures; no per-coin behaviour
  diverges.

---

# Constraints & Context

## Starting points

- `utxo/utxo_transaction_status.ts` — the class; lines ~90–101 carry the
  gross caveat and the "`inputs` is not yet surfaced … 2C UTXO port" note.
- `utxo/utxo_chain.ts` `getUtxoStatusOnce` — builds outputs and the
  per-address gross map today; switches to reading from the tool's
  `UtxoTransaction.netChangesHr` and populating `status.inputs` from
  `UtxoTransaction.inputs`.
- `utxo/utxo.ts` — `RawTransactionView { vin: TransactionInputRef[]
  {txid, vout}, vout: TransactionOutputView[] }`; `TransactionOutputView`
  already has `address | null`, `valueSats`, `scriptPubKeyHex`. The new
  `UtxoTransaction` and `UtxoTransactionInput` types live here.
- `utxo/tools/raw_transaction_provider.ts` — `getTransaction(txid)`,
  `getRawTransactionHexBatch`. New:
  `getTransactionWithInputs(txid): Promise<UtxoTransaction>`.
- **Python reference implementations** (parity target):
  `omnichain-py/src/omnichain/impl/utxo/base.py:get_transaction_status`,
  `class UtxoTransaction`, `class UtxoTransactionInput`;
  `omnichain-py/src/omnichain/impl/utxo/tools/bitcoin_core.py:get_tx` (the
  N-prevout walk pattern at line 453);
  `omnichain-py/src/omnichain/impl/utxo/tools/blockcypher.py:get_tx` (the
  inline-prevout parser pattern).
- `SINAN_OPEN_QUESTIONS.md` §"UTXO `_native_balance_changes` full
  input-side accounting" — this card closes it in the TS-catches-up
  direction.
- Consumers today: rango-intents
  `proof/domain/validation/tx_content_check.ts`
  (`inputAddresses: { kind: 'resolved' | 'unknown', complete, addresses }`)
  and `proof/services/proof_validation.service.ts:175-195` (family
  dispatch of senders); Clydner
  `watchers/services/push/blockcypher/blockcypher-payload.parser.ts:46-52`
  (`net = inputTotal − outputTotal`).

## Compatibility constraints

- `balanceChanges` semantics change on UTXO. rango-intents'
  `enrichInputTxFromChain` sums positive credits to the deposit address;
  on a fresh single-use vault address gross and net agree, so the deposit
  path is unaffected in the coincidence case — but the follow-up must
  move it to `outputs[]` iteration explicitly rather than rely on that
  coincidence.
- The `AdaptedTxStatus` shape in rango-intents (`tx_status_adapter.ts`)
  flattens `balanceChanges`; it needs no change for net values.
- Do not change the EVM or Solana status classes.
- Do not change `UtxoRawTransactionProvider.getTransaction` (the existing
  method stays for `nonWitnessUtxo` hex fetching); the new
  `getTransactionWithInputs` is additive to the provider interface.

## Dependencies / blockers

- None to start.
- Follow-ups filed (R10, AC14) when this ships:
  - rango-intents: replace BTC-8's parent-tx resolver with `status.inputs`,
    map `inputsUnresolvedReason` onto the existing `input_addresses_*`
    transient outcomes, and switch `enrichInputTxFromChain` to iterate
    `status.outputs[]`.
  - Clydner: drop the parser's own netting in favour of the SDK's, or
    document why it keeps its own (it parses BlockCypher payloads, not
    SDK statuses, so it may legitimately stay).
  - Python SDK parity: none needed — this card catches TS up to Python,
    not the other way.

## References

- `omnichain/docs/utxo.md`; `omnichain/CHANGELOG.md`;
  `INTEGRATOR_MIGRATION_v0.md`.
- Plan card BTC-8 (`BTC-8-utxo-proof-ownership.md`) — the workaround this
  removes the need for, and its "gross vs net" rationale.
- rango-intents PR #59 (BTC-8).
- Python reference: `getomnichain/omnichain-py` — `impl/utxo/base.py`,
  `impl/utxo/tools/{bitcoin_core,blockcypher}.py`.

---

# Open Questions

- **Q1.** Should input resolution be opt-in per call
  (`getTransactionStatus(hash, { resolveInputs: true })`) so deposit
  detectors that only need `outputs[]` pay no parent-fetch cost on the
  Bitcoin-Core `verbose=1`-fallback and Unisat paths, or always-on with
  the RPC cost the tool implies? Python is always-on. Recommend
  always-on for parity, with the escape hatch that Esplora and Bitcoin-Core
  `verbose=2` pay zero extra RPCs anyway.

- **Q2.** Bitcoin-Core adapter: default to `verbose=2` (needs Core ≥ 25.0)
  and fall back to `verbose=1`-loop on a `-32601 method not found` from an
  older node, or make it an explicit adapter constructor option
  (`bitcoinCoreVerbose: 2 | 1`) with no runtime probe? Runtime probe is
  friendlier; explicit option is one fewer moving part. Recommend explicit
  option and document `2` as the recommended value.

<!-- ========================= PART B - PLAN ========================= -->

---

# Implementation Plan

Ordered steps. Each step names the files or modules it touches and what
it changes there. Small enough that a step can be reviewed on its own.

---

# Technical Notes

Only the subsections that actually apply to this task.

## Affected modules

## External integrations

## API contract changes

---

# Verification

The exact commands a reviewer runs, and what each should produce. Name
the tests that cover each acceptance criterion.

<!-- ====================== PART C - DEVIATIONS ====================== -->

---

# Deviations from the plan

- **R5 / AC8 — hydration failure on a confirmed tx throws, does not
  return a partial status.** R5 as written ("does not throw",
  `inputs: null` + `balanceChanges: null`) is unimplementable against the
  base `TransactionStatus(Success)` invariant at
  `transaction_status.ts:279` which requires `balanceChanges !== null`
  when `status === Success`, and the `Pending` slot has no `error` field
  either (`:321`). Two ways out: change the base invariant (out of
  scope, ripples into EVM/Solana), or throw on confirmed + unresolved.
  Picked the throw:
  - Confirmed + hydration failed → `ChainError(RpcError)` with the
    sanitized provider message as `cause`. The `Success` return path is
    only reached when `balanceChanges` can be populated from
    `netChangesHr`.
  - Consequence for the enum: `'provider_error'` and `'parent_missing'`
    were never reachable on the returned status. Narrowed
    `UtxoInputsUnresolvedReason` to `'pending'` — the only value the
    status can actually carry — so the type does not advertise states a
    consumer will never observe. AC8 rewritten: hydration failure on
    confirmed asserts a thrown `ChainError(RpcError)`, not a partial
    `Success`.
  - Class docstring on `UtxoTransactionStatus` rewritten to state the
    throw explicitly and drop the "may carry" language.
  - Availability note: consumers whose provider tool cannot hydrate a
    given confirmed tx (e.g. Bitcoin Core `verbose=1` on a node without
    `-txindex`, or a transient 429/timeout on the second read) can
    still recover the outputs-side view by falling back to
    `rawTxProvider.getTransaction` directly. That is a consumer-side
    decision, not an SDK code path.

---

# Follow-ups raised

Work found during implementation that was deliberately not done here.
Link the YouTrack issue for each one, or state that it was decided
against.
