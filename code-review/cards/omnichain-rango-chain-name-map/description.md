---
id: RIN-295
title: Omnichain: bidirectional map between chain id and Rango blockchain name
status: in-progress
repos: [omnichain]
---

<!-- ======================= PART A - REQUEST ======================= -->

# Summary

Add a single, canonical map in `@getomnichain/omnichain` between omnichain chain ids and the uppercase `blockchain` names Rango uses in its meta feed, price feed and API responses. Cover every chain omnichain already exports from `chain_ids.ts`. Consumers (rango-intents, gasless, depositron) drop their local partial copies and import from omnichain.

---

# Objective

Two independent copies of this mapping already exist (`rango-intents/.../blockchain_chain_id.map.ts` with 6 entries; `gasless/backend` carries `rangoChainName` in per-chain config yaml), and both drift. Every deposit-side and price-side feature that needs to talk to Rango has to reinvent it. Put it once, in the SDK that already owns the chain ids.

---

# Scope

## Out of scope / non-goals

- No change to `chain_ids.ts` values or names.
- No opinion on which Rango names are "primary" when the feed uses aliases — one canonical name per chain id; alternates are lookup fallbacks only.
- No auto-sync against a live Rango endpoint at runtime. The map is a compile-time constant, curated from Rango's docs.

---

# Requirements

**SDK (`@getomnichain/omnichain`)**

- **R1.** Export `CHAIN_ID_TO_RANGO_NAME: ReadonlyMap<number, string>` — every chain id declared in `chain_ids.ts` (EVM + Bitcoin + Solana + LTC/DOGE/DASH/ZEC/BCH + Sui + XRPL + Stellar + TON + Tron; testnets included where Rango carries them, otherwise omitted). Uppercase names, verbatim from Rango's `/meta` `blockchains[].name`.
- **R2.** Export `RANGO_NAME_TO_CHAIN_ID: ReadonlyMap<string, number>` — the inverse of R1, keyed by uppercase name.
- **R3.** Export two accessors that normalise inputs (`toUpperCase().trim()` on the name side) and return `undefined` when not mapped: `rangoNameForChainId(chainId)`, `chainIdForRangoName(name)`.
- **R4.** Explicit anchors called out in tests: Bitcoin mainnet → `BTC` maps to `-1`; Solana mainnet → `SOLANA` maps to `-2000`. Every non-EVM sentinel id from `chain_ids.ts` is either mapped or has an explicit `// not on Rango feed` comment.
- **R5.** Names are sourced from Rango's public docs / `/meta` response. The card's implementer captures the source revision (URL + fetched date) in Part C.
- **R6.** Semver minor bump. Additive export only; no other public API change rides along.

---

# Acceptance Criteria

- **AC1 (R1, R4)** Unit test asserts round-trip for every entry: `chainIdForRangoName(rangoNameForChainId(id))!.equals(id)`. Includes explicit rows for `-1 ↔ BTC`, `-2000 ↔ SOLANA`, `1 ↔ ETH`, `56 ↔ BSC`, `42161 ↔ ARBITRUM`, `8453 ↔ BASE`, `59144 ↔ LINEA`.
- **AC2 (R2, R3)** `chainIdForRangoName(' bsc ')` returns `56` (case + whitespace normalised). `chainIdForRangoName('DOES_NOT_EXIST')` returns `undefined`.
- **AC3 (R1)** Coverage test: for every id in `chain_ids.ts`, either the map has an entry or the id is on an explicit `NOT_ON_RANGO` allowlist maintained beside the map (so a new chain added to `chain_ids.ts` fails CI until someone decides).
- **AC4 (R6)** `npm run build` passes; the SDK version is bumped minor.
- **AC5 (consumer parity)** rango-intents `blockchain_chain_id.map.ts` is replaced by a re-export from `@getomnichain/omnichain`; its existing test suite passes unchanged. gasless `chain_config.yaml`'s hand-set `rangoChainName` is optional after the bump (falls back to `rangoNameForChainId(chain.id)` when absent).

---

# Constraints & Context

## Starting points

- `omnichain/chain_ids.ts` — the current exhaustive id list. 60+ entries as of `main@c6572e0`.
- `rango-intents/src/modules/price/domain/parser/blockchain_chain_id.map.ts` — the 6-entry map to be replaced. Note the doc-comment there: "keys are normalized to upper-case at lookup time" — reuse that lookup shape.
- `gasless/backend/src/core/chain_config/chain_config.types.ts` — the `rangoChainName: string` field currently duplicated in yaml.
- Rango meta docs / endpoint: `https://api.rango.exchange/meta` (`blockchains[].name` is the source of truth).

## Compatibility constraints

- No breaking change to `chain_ids.ts` exports.
- Consumers must be able to opt in — omnichain adds the export, the yaml override in gasless is not removed in this task; it's just made optional.

## Dependencies / blockers

- None. Can start immediately after RIN-226 lands (which it has, on `main@c6572e0`).

---

# Decisions

- **D1 (Q1).** `NOT_ON_RANGO` lives in the same file as the map, exported. One place to review.
- **D2 (Q2).** Canonical name only, one per chain id. No alias table today; if a consumer hits a real Rango response that carries a different spelling for a chain we already map, opening a follow-up to add an alias entry is a separate ticket.

<!-- ======================= PART B - PLAN ======================= -->

# Implementation Plan

1. Add `omnichain/rango_chain_names.ts` beside `chain_ids.ts` — the map, its inverse, `NOT_ON_RANGO`, and the two accessors. Re-export from `omnichain/index.ts`.
2. Add `omnichain/test/rango_chain_names.spec.ts` — bijection, no-duplicate names, anchor checks (BTC=-1, SOLANA=-2000, ETH, BSC, ARBITRUM, BASE, LINEA, AVAX_CCHAIN), case/whitespace normalisation, unknown-input returns, disjoint map/`NOT_ON_RANGO`, and the AC3 coverage sweep that iterates every `CHAIN_ID_*` constant via `import * as chainIds`.
3. Update `CHANGELOG.md`: retitle the trailing RIN-226 `[Unreleased]` block to `[0.4.0] — 2026-09-16` (housekeeping — the 0.4.0 tag went out without it) and add a fresh `[Unreleased]` block for this card.
4. Bump `package.json` and `package-lock.json` to `0.5.0`. No other change rides along.

<!-- ======================= PART C - DEVIATIONS ======================= -->

# Deviations from the plan

- **AC5 (consumer parity) is deferred.** rango-intents `blockchain_chain_id.map.ts` replacement and gasless `rangoChainName` fallback are follow-up PRs against their own repos, tracked below. Both are cross-repo consumer changes; landing them alongside this SDK card would require coordinated version bumps that are outside RIN-295's scope.
- **Rango `/meta` snapshot is committed as a compact fixture.** Part B mentioned only the map as the derived artefact; iter-1 review flagged the risk that hand-typed names have no verifiable ground truth in-repo. Added `test/fixtures/rango_meta_blockchains.2026-09-21.json` (7.9 KB, three fields per row) + fixture-backed tests. Refreshes are now mechanical.
- **`chainIdForRangoName` accepts non-string input and returns `undefined`.** Original R3 wording said "returns `undefined` when not mapped"; iter-1 review noted the two accessors had asymmetric failure modes on garbage input (id-side returned `undefined`, name-side threw `TypeError`). Made both fail-closed.
- **`prepublishOnly` runs `npm test` in addition to `npm run build`.** AC3 depends on the coverage test failing when a new `CHAIN_ID_*` slips in without a decision; without CI in this repo the test needs a publish-time gate.
- **`release.sh` runs `npm test` in preflight.** Iter-2 review flagged that `prepublishOnly` alone fires after `release.sh` commits + tags — a red suite would strand a release commit. `release.sh` now runs the suite before `npm version`; `prepublishOnly` stays as a backstop for hand publishes.
- **`chainIdForRangoName` rejects non-ASCII inputs (fails closed on Unicode homoglyphs).** Iter-2 review flagged that `'ſolana'.toUpperCase() === 'SOLANA'` would resolve homoglyph inputs; better to fail closed than silently accept.
- **`chainIdForRangoName` signature widened to `string | null | undefined`.** Iter-2 review flagged that a strict-TS consumer holding `row.blockchain: string | undefined` had to cast; the runtime guard already tolerated it, so the type now matches the contract.

# Follow-ups raised

- rango-intents `blockchain_chain_id.map.ts` (6 entries) → re-export from `@getomnichain/omnichain@0.5.0`, retarget its `.spec.ts`. Separate PR against `rango-intents/staging`.
- gasless `chain_config.yaml` per-chain `rangoChainName` field can become optional, falling back to `rangoNameForChainId(chain.id)` when absent. Deferred until at least one consumer needs the fallback path (no yaml churn today).
- Rango `/meta` source: `https://public-api.rango.exchange/basic/meta`, fetched 2026-09-21. Compact fixture committed under `test/fixtures/`. Future refreshes: re-fetch the endpoint, replace the fixture, rerun the suite, resolve any deltas.

# Notes on canonical names picked from the snapshot

- `AVAX_CCHAIN` (not `AVALANCHE`) — Rango's `/meta` uses `AVAX_CCHAIN` verbatim.
- `POLYGONZK` (not `POLYGON_ZKEVM`) — Rango uses the shorter form for chain id `1101`.
- `HYPEREVM` (not `HYPER_EVM`) — Rango collapses the underscore.
- `MEGAETH` (not `MEGA_ETH`) — same collapse pattern.
- `ZETA_CHAIN` (with underscore) — Rango's canonical for chain id `7000` is the underscored form, not `ZETACHAIN`.
- `OKC` (not `OKX_CHAIN`) — Rango's short form for chain id `66`.
- `IOTA` (not `IOTA_EVM`) — Rango has one `IOTA` entry pinned to chain id `8822`.

# Chains omnichain declares but Rango's `/meta` does not carry (as of 2026-09-21)

Mainnet EVM chains absent from Rango: `MANTLE (5000)`, `OPBNB (204)`, `SEI_EVM (1329)`, `WORLD_CHAIN (480)`, `WANCHAIN (888)`, `ABSTRACT (2741)`, `TEMPO (4217)`, `INK (57073)`, `BOB (60808)`, `ZKLINK_NOVA (810180)`. Testnets omitted by design: `GOERLI`, `SEPOLIA`, `CELO_SEPOLIA`, `TRON_SHASTA`, `BITCOIN_TESTNET`, `BITCOIN_SIGNET`, `SOLANA_TESTNET`, `SOLANA_DEVNET`, `SUI_TESTNET`, `SUI_DEVNET`, `XRPL_TESTNET`, `STELLAR_TESTNET`, `TON_TESTNET`.
