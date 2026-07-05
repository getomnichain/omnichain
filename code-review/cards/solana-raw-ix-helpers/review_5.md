# Review Findings

## Critical
- None.

## Medium
- [solana/solana_chain.ts:6539-6540 (diff) / solana_chain.ts:653-655] Redundant on-chain read of the mint account per SPL build.
  - `buildSplTransferInstructions` calls `resolveTokenProgramId(req.mint)` directly, then `resolveMintDecimals(req.mint)` — but `resolveMintDecimals` internally calls `resolveTokenProgramId(mint)` again (solana_chain.ts:588) before `getMint`. Net result on the real-money path: `getAccountInfo(mint)` is issued twice plus `getMint` (a third account read) for the same immutable mint. This is exactly the focus-area concern ("no unnecessary RPC calls").
  - Mitigating context: the identical pattern already exists in `createTransferUnsignedTransaction` (solana_chain.ts:297-299), the card explicitly excludes changes to `resolveMintDecimals`, and commit `b9371c0`/`612c466` shows a dedup was tried and deliberately reverted to keep the test mocks and card spec intact. So it is consistent and not a regression.
  - Suggested fix (optional, out of card scope): add an internal `resolveMintInfo(mint)` returning `{ programId, decimals }` from a single `getAccountInfo`/`getMint` pair and have both `resolveMintDecimals` and this method consume it — without changing the public signatures the card froze. If deferred, leave a `// TODO` noting the triple read.

## Minor
- [solana/solana_chain.ts:6474 (import) / solana_chain.ts:13] New import symbol `createAssociatedTokenAccountIdempotentInstruction` from `@solana/spl-token` — not previously referenced anywhere in the repo (confirmed by grep). omnichain ships no `package.json`, so this depends entirely on the consumer's pinned `@solana/spl-token` exporting it. It has existed since spl-token ≥0.2, so this is almost certainly fine, but per the SDK's "flag any new import" rule: confirm pluton-back-end and depositron both resolve a version that exports it.
  - Suggested fix: none if the consumer lockfiles are ≥0.2; just verify.
- [solana/solana_chain.ts:6549-6553] The `deriveAta` catch swallows the original error and rethrows a synthesized `ChainError` without forwarding the caught `err` as the cause (other `ChainError` sites in this file pass `err` as the 4th positional arg, e.g. solana_chain.ts:508). Loses the original stack for diagnostics.
  - Suggested fix: pass `err` as the cause argument to the `ChainError` constructor.
- [solana/solana_chain.ts:6543-6555] The catch is broader than the documented intent: it maps *any* throw from `getAssociatedTokenAddressSync` to `InvalidAddress` "off-curve". In practice that function only throws `TokenOwnerOffCurveError` for already-constructed `PublicKey` inputs, so this is acceptable, but a future spl-token change could mislabel an unrelated failure as "off-curve".
  - Suggested fix: narrow by checking `err instanceof TokenOwnerOffCurveError` (or `err?.name`) before mapping, and rethrow anything else unchanged.

## Missing Tests
- Coverage is otherwise strong (all five card functional cases plus idempotent-variant lock, account-wiring, and off-curve failure). Gaps, all low value:
  - No test asserting the destination-side off-curve rejection (only the source side is exercised at solana_chain.ts spec:6735). Since `deriveAta` is called for `source` first, a regression that only broke the destination branch would pass. A `from: ALICE (on-curve), to: pdaTo, allowOwnerOffCurve:false` case would pin `destination owner is off-curve`.
  - No `includeCreateAta:false` case combined with Token-2022 (the length-1 path is only tested on classic SPL) — marginal.

## Overall Assessment
Safe to merge. The two helpers correctly mirror the argument order and semantics of the existing `createTransferUnsignedTransaction` internals, apply `allowOwnerOffCurve` to both source and destination as the card mandates, fail closed on non-positive amounts and off-curve owners with typed `ChainError`s, add no consumer-specific coupling, introduce no `any`, and are exported through the existing `solana/index.ts` barrel. README and tests satisfy the acceptance criteria. The only substantive residual is the triple mint-account read on the SPL path, which is a pre-existing, card-excluded, deliberately-preserved pattern rather than a new defect — worth a follow-up ticket but not a merge blocker. Remaining risk is limited to the consumer's `@solana/spl-token` version exporting the new idempotent-instruction symbol, which should be verified in the RIN-72 bump. Confidence: high.
