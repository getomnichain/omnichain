# omnichain 0.2.1: unblock CJS consumers + peer-dep the decorator libs (RIN-152 SDK scope)

Status: Draft

# Summary

Ship `@getomnichain/omnichain@0.2.1` as a hygiene-only patch that lets any CJS-target consumer (gasless, pluton-back-end, rango-intents) install and load the package. Zero API changes, zero Python-parity drift. Everything Sinan flagged in RIN-152 that is NOT SDK-owned (native-token sentinel handling, EIP-7702, Jito bundles, ALT public API, multi-endpoint RPC failover, raw broadcast) is out of scope for this card — moved to the sister gasless card or to future waves.

# Objective and Expected Impact

The 0.2.0 package published on 2026-07-27 is pure ESM (`"type": "module"`, no `require` condition in `exports`) and pins `class-validator` + `class-transformer` as regular `dependencies`. Every consumer targeting CJS output (all of gasless, pluton-back-end, rango-intents via `nest build`) crashes at `require('@getomnichain/omnichain')` with `ERR_REQUIRE_ESM`. Every consumer whose own `class-validator` version differs from ours (gasless on 0.14, ours on ^0.15) gets two copies in `node_modules`, and `class-validator`'s decorator-metadata registry is per-copy — decorators registered against our copy are invisible to the consumer's validator run, so DTO validation silently no-ops with no error surfaced.

Fixing both is a mechanical release-engineering change. Once shipped, gasless can adopt the npm package in a single `npm install @getomnichain/omnichain@0.2.1` commit instead of waiting on a follow-up SDK release.

# Scope

## Included

- Dual `exports` map: emit `dist/esm/` (ESM) + `dist/cjs/` (CJS) via two `tsc` configs; per-directory `package.json` `type` override tells Node which loader to use. Update `main` / `types` / `exports` accordingly.
- Move `class-validator` from `dependencies` to `peerDependencies` with range `^0.14.0 || ^0.15.0 || ^0.16.0` (covers gasless 0.14 and depositron ^0.15). Keep in `devDependencies` mirror so our own build/tests still resolve it.
- Move `class-transformer` from `dependencies` to `peerDependencies` with range `^0.5.0`. Same devDependencies mirror.
- `peerDependenciesMeta`: both marked `optional: false`.
- Version bump `0.2.0` → `0.2.1`.
- CHANGELOG entry.
- Docs: README + `docs/PUBLISHING.md` note the peer-dep requirement + CJS support.

## Explicitly excluded (moved to sister cards / future waves)

- **Native-token sentinel** (`NATIVE_TOKEN_SENTINEL`, `@IsAddress` short-circuit). Not in Python. `Token.isNative()` is already the SDK's Python-parity native check. Any string-convention translation is consumer-side — handled in the paired **gasless RIN-YYY** card.
- **Raw broadcast on `Chain`** (`broadcast_signed_transaction` in Python). Real parity gap but non-trivial (EVM + Solana impl + error taxonomy). Split into follow-up **omnichain Wave 2C** card.
- **EIP-7702 opt-in extension**, **Jito bundle client**, **Address Lookup Tables as public API**, **multi-endpoint RPC failover**, **`getAccountInfo` / `ataExists` / `getSignatureStatuses` batch as public methods**. None of these exist in Python. Consumer-side today (gasless); if elevated to SDK later, tracked as a separate `@getomnichain/omnichain-extensions` package proposal.
- **`decimal.js` → peer**. Skipped: `chain.base.ts` already does a structural probe + `.toString()` round-trip that handles two-copy consumer trees.
- **CJS smoke CI + peer-dedupe CI assertion**. Regression-prevention only; can land in a follow-up hygiene card.

# Requirements

## Functional Requirements

- `require('@getomnichain/omnichain')` succeeds on Node ≥ 20 in a CJS-target consumer project (top-level `package.json` without `"type": "module"`).
- `import from '@getomnichain/omnichain'` continues to succeed in an ESM-target consumer (depositron regression check).
- Subpath exports (`./evm`, `./solana`, `./utxo`, `./ton`) resolve under both loaders.
- `npm install @getomnichain/omnichain@0.2.1` in a consumer that already has `class-validator@0.14` or `class-validator@^0.15` produces exactly one copy in `node_modules` (no npm peer-warning about missing peer, no `ERESOLVE` failure).
- Existing exported API surface (`Chain`, `Token`, `AssetBalanceChange`, `NestedBalanceChanges`, `EvmChain`, `SolanaChain`, `UtxoChain`, factories, `resolveTransferAmount`, etc.) is unchanged. No renames, no additions.

## Technical Requirements

- Two build configs (`tsconfig.build.esm.json`, `tsconfig.build.cjs.json`) both extending `tsconfig.json`. Both emit under `dist/`, into `esm/` and `cjs/` respectively.
- Build script: `npm run build:esm && npm run build:cjs && node scripts/write-dist-pkg-types.mjs` (the last writes the per-directory `package.json` `type` overrides).
- `package.json` `exports` map has `types` / `import` / `require` conditions for the root and each subpath.
- Peer ranges chosen so `class-validator` 0.14/0.15/0.16 all satisfy; 0.14 in gasless is not bumped to satisfy this card.
- No source `.ts` changes beyond what's needed to satisfy the new build configs.
- Node engine floor unchanged: `>=20.0.0`.

# Technical Scope

## Affected Modules

- `package.json` (deps + exports + scripts).
- `tsconfig.build.esm.json` (new).
- `tsconfig.build.cjs.json` (new).
- `scripts/write-dist-pkg-types.mjs` (new).
- `scripts/release.sh` (existing — unchanged, already runs `npm run build`).
- `README.md` + `docs/PUBLISHING.md` (peer-dep guidance + CJS support note).
- `CHANGELOG.md` (new or extended).

## Database Changes

None. Stateless SDK.

## External Integrations

None. Consumes no new external services.

# API Contracts

None. Purely release-engineering — no API additions, no schema changes.

# Acceptance Criteria

- Fresh clone → `npm install && npm run typecheck && npm run build` produces both `dist/esm/index.js` and `dist/cjs/index.js` with matching public exports.
- `dist/esm/package.json` = `{"type":"module"}`; `dist/cjs/package.json` = `{"type":"commonjs"}`.
- A throwaway CJS test project (`nest build`-style tsconfig with `module: commonjs`) that does `const om = require('@getomnichain/omnichain')` runs without `ERR_REQUIRE_ESM` and can call `om.arbitrumChain(...)`, `new om.EvmToken(...)`, etc.
- A throwaway ESM test project that does `import { arbitrumChain } from '@getomnichain/omnichain'` continues to work.
- In a consumer with `class-validator@0.14` already declared, `npm install @getomnichain/omnichain@0.2.1` does NOT install a second copy of `class-validator` (`npm ls class-validator` shows one line).
- `npm publish` publishes with `0.2.1` on the `latest` tag; `npm view @getomnichain/omnichain dist-tags.latest` returns `0.2.1`.

# Security Considerations

- Peer-dep move surfaces `class-validator` / `class-transformer` version choice to the consumer. Consumers should not pin dev-only ranges that would be missed by production installs — flag in the README.
- No new code paths, no new attack surface.

# Edge Cases

- Consumer on `class-validator` outside `^0.14 || ^0.15 || ^0.16`: npm surfaces a peer warning; SDK still works at runtime as long as the shape hasn't drifted. Documented in the README.
- Consumer using `pnpm` with strict peer-dep isolation: `pnpm install` will require the peer to be declared. Documented.
- Consumer using yarn v1 (no auto-install of peers): manual install required. Documented.
- Node ≤ 20.19 without conditional-exports support: package still loads via `main` / `module` fallback. Node engine floor keeps this bounded.

# Testing Requirements

## Unit Tests

- No new units. Existing decorator + address + token tests are unchanged (the DTOs still resolve `class-validator` from the mirrored `devDependencies`).

## Integration Tests

- Build both formats; assert each barrel exports the same public names via a diff script.

## E2E Tests

- Manual smoke: one `.cjs` file that `require`s the built tarball and calls a factory + a public helper. One `.mjs` file that imports the same.

## Validation Tests

- `npm pack --dry-run` shows only `dist/`, `docs/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json` — no source `.ts`, no `code-review/`, no `.env`.

## CI Requirements

- Existing `npm run typecheck` and `npm run build` still pass. No new CI jobs added by this card (the CJS smoke + peer-dedupe assertions are in the follow-up card).

# Definition of Done

- `package.json` updated (version, deps, exports, scripts).
- Both build configs + the postbuild dist-package.json helper committed.
- README + `docs/PUBLISHING.md` mention peer-dep + CJS support.
- CHANGELOG entry for 0.2.1.
- PR opened on `getomnichain/omnichain` (canonical) against `main`.
- Reviewer run + no criticals surviving the loop.
- Merged, `scripts/release.sh patch` executed, `@getomnichain/omnichain@0.2.1` on npm.
- Tag `v0.2.1` on `getomnichain/omnichain` (and `pluton-bridge/omnichain` mirror during transition).

# Dependencies / Blockers

- None. Independent of any other card. Blocks: **gasless RIN-YYY** (adoption card) — that card starts once this ships to npm.

# Deployment Notes

- No env vars, no infra changes, no migrations. Publish is `scripts/release.sh patch` from `main`.

# Deliverables

- `@getomnichain/omnichain@0.2.1` on npm registry, `latest` tag.
- `v0.2.1` tag on `getomnichain/omnichain`.
- Updated README + PUBLISHING guide.

# References

- Parent: [RIN-152](https://rango.youtrack.cloud/issue/RIN-152) — full gap analysis (Sinan).
- Sister card: **gasless RIN-YYY** — adoption + consumer-side handling.
- Prior release: `@getomnichain/omnichain@0.2.0` on npm.
