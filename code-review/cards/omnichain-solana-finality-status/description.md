---
id: RIN-296
title: Omnichain: surface Solana finality on SolanaTransactionStatus (slot, confirmations, confirmationStatus, signers)
status: in-progress
repos: [omnichain]
parent: RIN-285
---

<!-- ======================= PART A - REQUEST ======================= -->

# Summary

SDK half of RIN-285. Adds four fields to `SolanaTransactionStatus` (`slot`, `confirmations`, `confirmationStatus`, `signers`) and populates them in `SolanaChain.getTransactionStatus`. Consumers gain a carried finality count on Solana the same way UTXO surfaces it (RIN-195) and EVM derives it from `blockNumber` — one non-blocking status read tells the poller how close to finality the tx is.

Dependent on: **RIN-285** (parent — covers rango-intents adapter consumption + integration tests). RIN-285 cannot close until both this card and its rango-intents follow-up land.

---

# Objective

`readTxStatus` in rango-intents derives finality from a count the SDK's `TransactionStatus` carries (UTXO — set by RIN-195) or from `blockNumber` against `getChainTipHeight` (EVM). Solana carries neither today, so every Solana transaction reads `confirmations: null` and never crosses the `confirmationBlocks` gate — retry policy exhausts, deposit or fill refunded.

This card lets the SDK read the fields Solana's RPC already returns and put them on the status, plus the signer set the destination-fill-proof card will need (one RPC call the SDK already has in hand).

---

# Scope

**Omnichain SDK only.** RIN-285 owns the rango-intents adapter changes (R5, R6, AC5, AC6) and the integration test. This card ships the SDK change RIN-285's R1/R2/R3/R4/R7 depend on.

## Out of scope / non-goals

- No change to the UTXO or EVM finality path; each family keeps its shape.
- No new `wait: true` behaviour on Solana. `getTransactionStatus`'s existing `wait`/`timeoutMs` polling opts stay as they are; the fields land on the default single-status read too, so a non-blocking poller sees them without opting in.
- No py-parity change. Python handles Solana finality with a different pattern (commitment parameter + blocking-wait helper); this card adds a new lane for TS's non-blocking pollers without touching either lane already in place. A py-side card can mirror the pattern later if a py consumer needs it.
- No proof-ownership / signer-based validation logic. `signers[]` is surfaced here; the destination-fill-proof card consumes it.

---

# Requirements

**SDK (`@getomnichain/omnichain`)**

- **R1.** `SolanaTransactionStatus` and `SolanaTransactionStatusInit` (`solana/solana_transaction_status.ts`) gain four fields:
  - `slot: number | null` — from `getTransaction.slot` on the success path; from `getSignatureStatus.slot` on the ledger-pruned fallback.
  - `confirmations: number | null` — from `getSignatureStatus.confirmations`. Rooted responses (where the RPC returns `null`) are normalised to a new exported `SOLANA_FINALIZED_CONFIRMATIONS = 32` so consumers see a monotone count.
  - `confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null` — raw RPC string.
  - `signers: readonly string[]` — base58 signer keys marked `isSigner` in the transaction message, in message order (the first `header.numRequiredSignatures` `staticAccountKeys`). Mirrors omnichain-py `signer_keys = account_keys[: header.num_required_signatures]` at `impl/solana/base.py:1175`. Empty on the ledger-pruned fallback and on `notFound`.

  All fields optional in the init with safe defaults (`null` / `[]`) so every pre-0.6.0 `successful/failed/pending/notFound` call site compiles unchanged.

- **R2.** `SolanaChain.getTransactionStatus` (`solana/solana_chain.ts`) populates them:
  - Success path — `slot` and `signers` from the `getTransaction` response the SDK already fetches; `confirmations` + `confirmationStatus` from `getSignatureStatus`.
  - Ledger-pruned fallback — `slot`/`confirmations`/`confirmationStatus` from `sig.value`; `signers: []` (message unavailable).

- **R3.** `blockNumber` is **not** set to `slot` and is **not** added to the status. Slots are not block heights (skipped slots exist) and `getChainTipHeight` returns a block height (0.3.3 fix) — the scales differ, do not subtract. The generic `readTxStatus` fallback in rango-intents must keep seeing `blockNumber: null` for Solana and read the carried `confirmations` instead.

- **R4.** Semver **minor** bump. `docs/solana.md` documents the four fields, the `SOLANA_FINALIZED_CONFIRMATIONS = 32` normalisation, and the `signers` ordering.

- **R5.** No other SDK behaviour change rides along.

---

# Acceptance Criteria

- **AC1 (R1, R2).** Stubbed `getTransaction` returning a tx with `slot: 300_000_000` and a 2-signer + 1-non-signer message + stubbed `getSignatureStatus` returning `{ confirmations: 5, confirmationStatus: 'confirmed' }` yields `slot === 300_000_000`, `confirmations === 5`, `confirmationStatus === 'confirmed'`, `signers.length === 2` in message order.
- **AC2 (R1).** Stubbed `getSignatureStatus` returning `{ confirmations: null, confirmationStatus: 'finalized' }` yields `confirmations === SOLANA_FINALIZED_CONFIRMATIONS` (32).
- **AC3 (R2).** Stubbed `getTransaction: null` + `getSignatureStatus` finalized + no err yields a Pending status with `slot === 299_999_999`, `confirmations === 32`, `confirmationStatus === 'finalized'`, `signers === []`. Same fixture with `err` set yields Failed with the same finality carried.
- **AC4 (R1).** Fee-payer-only tx yields `signers.length === 1`.
- **AC5 (R3).** `hasOwnProperty('blockNumber')` is `false` on a `SolanaTransactionStatus` instance.
- **AC6 (R4).** `npx tsc --noEmit` clean, `npm run build` clean, `package.json` version bumped to `0.6.0`, `docs/solana.md` lists the four fields + the constant.
- **AC7 (R1).** Every pre-existing `SolanaTransactionStatus.successful/failed/pending/notFound` call site compiles unchanged. New fields default to `null` / `[]`.

---

# Decisions

RIN-285's Open Questions and this card's implementation-choice questions (asked upfront):

- **Q1 (RIN-285)** — Finalized normalisation lives in the SDK, not each consumer. This card exports `SOLANA_FINALIZED_CONFIRMATIONS = 32` and normalises in `getTransactionStatus`.
- **Q2 (RIN-285)** — `signers` is whatever the message marks `isSigner`, verbatim; the proof card filters. This card ships `signers.length === header.numRequiredSignatures`.
- **D1 (this card)** — `getSignatureStatus` runs **in parallel** with `getTransaction` via `Promise.allSettled`. Success case pays one round-trip of latency instead of two.
- **D2 (this card)** — Sig-status failure on the Success path **degrades gracefully**: the status keeps `slot` + `signers` populated (from `getTransaction`) with `confirmations` and `confirmationStatus` as `null`. A working tx read must not fail because a metadata-enrichment read failed.
- **D3 (this card)** — `SolanaTransactionStatus.pending()` accepts optional finality fields, so the ledger-pruned still-propagating branch surfaces what it already fetched instead of dropping it.

---

# Constraints & Context

## Starting points

- SDK `solana/solana_transaction_status.ts` — factories `successful` / `failed` / `pending` / `notFound`, `SolanaTransactionFees`.
- SDK `solana/solana_chain.ts` — `getTransactionStatus` single-hash path calls `getTransaction` (:908 pre-RIN-296) and falls back to `getSignatureStatus` when tx is null.
- SDK `solana/solana_chain.ts:1021` — `getChainTipHeight` returns `getBlockHeight('confirmed')` (0.3.3 fix, pinned by `chain_tip_height.spec.ts`), confirming R3's rationale.
- Python signer extraction: `omnichain-py/src/omnichain/impl/solana/base.py:1175` and `:1701`.

## Compatibility constraints

- Additive only. All new fields optional in the init, safe defaults on the factories. Every existing SDK + consumer call site compiles unchanged.
- Gasless and depositron consume the same package and must compile without edits.

## Dependencies / blockers

- **RIN-285** — this card is the SDK half. RIN-285 cannot close until both this card and its rango-intents follow-up land.
- Feeds the destination-fill-proof card (signer set consumer).

<!-- ======================= PART B - PLAN ======================= -->

# Implementation Plan

1. Add four fields to `SolanaTransactionStatusInit` + `SolanaTransactionStatus` + all four factories. Export `SOLANA_FINALIZED_CONFIRMATIONS` and the `SolanaConfirmationStatus` type. `pending()` takes an optional `finality` block (D3).
2. Rewrite `getSolanaStatusOnce` in `solana/solana_chain.ts` to fire `getTransaction` + `getSignatureStatus` in parallel via `Promise.allSettled` (D1). Handle the two rejection modes: `getTransaction` rejection throws `ChainError(RpcError)`; `getSignatureStatus` rejection on the Success path degrades to `null` finality fields (D2), on the ledger-pruned fallback throws `ChainError(RpcError)` (nothing to fall back to). Wire slot / signers / confirmations / confirmationStatus into every factory call (D3).
3. Two small module-scope helpers: `extractSolanaConfirmationStatus(raw)` narrows the RPC string to the union or null; `normaliseSolanaConfirmations(sigValue)` normalises rooted-null → 32.
4. `docs/solana.md` — document the four fields, the normalisation constant, and D2's soft-fail behaviour.
5. `CHANGELOG.md` — `[0.6.0]` block. `package.json` + `package-lock.json` — bump 0.5.0 → 0.6.0.
6. `solana/test/solana_finality.spec.ts` — 12 tests covering AC1–AC5, AC7, plus D1/D2/D3 and the `notFound` / `!tx.meta` paths.

<!-- ======================= PART C - DEVIATIONS ======================= -->

# Deviations from the plan

None.

# Follow-ups raised

- rango-intents adapter changes (RIN-285's R5/R6/AC5/AC6/AC7/AC8) — separate PR against `rango-intents/staging` after this SDK version publishes.
