# omnichain: SolanaChain raw-instruction helpers for depositron `SOL_INSTRUCTIONS`

Status: Draft

## Summary

Add two public methods to `SolanaChain` that return raw `TransactionInstruction[]` (not a compiled `VersionedTransaction`). Depositron's `SOL_INSTRUCTIONS` action type accepts a list of program instructions and compiles the tx server-side (its own blockhash, its own fee-payer). It does not accept a pre-built tx.

Today pluton-back-end has a local `sol_instruction_builder.ts` file that imports `@solana/web3.js` and `@solana/spl-token` directly and composes these instructions itself. That's a chain-SDK leak into an application repo — chain primitives belong in omnichain. Once these helpers ship, that file gets deleted and pluton-back-end's `action_builder.ts` calls omnichain-only.

`createTransferUnsignedTransaction` already does most of this work, but returns a compiled `VersionedTransaction`. The new helpers surface the instruction-list layer so a caller compiling downstream (or not compiling at all — depositron doesn't need us to) can consume it.

---

## Scope

### Included

1. **New method on `SolanaChain`.**

   ```ts
   buildNativeTransferInstruction(
     from: PublicKey,
     to: PublicKey,
     lamports: bigint,
   ): TransactionInstruction
   ```

   - Synchronous. Wraps `SystemProgram.transfer`.
   - Reason to add it (vs. calling `SystemProgram.transfer` directly at callers): keeps the `@solana/web3.js` import out of every caller repo. Consistency with the SPL helper.

2. **New method on `SolanaChain`.**

   ```ts
   buildSplTransferInstructions(req: {
     from: PublicKey;
     to: PublicKey;
     mint: PublicKey;
     amount: bigint;
     includeCreateAta?: boolean;    // default true
     allowOwnerOffCurve?: boolean;  // default false
   }): Promise<TransactionInstruction[]>
   ```

   Internal behavior:
   - Calls existing `resolveTokenProgramId(mint)` — Token-2022 vs classic SPL auto-detected from mint account owner.
   - Calls existing `resolveMintDecimals(mint)`.
   - Derives source ATA: `getAssociatedTokenAddressSync(mint, from, allowOwnerOffCurve, programId)`.
   - Derives destination ATA: `getAssociatedTokenAddressSync(mint, to, allowOwnerOffCurve, programId)`.
   - When `includeCreateAta === true`: prepends `createAssociatedTokenAccountIdempotentInstruction(from, destAta, to, mint, programId)`.
   - Always appends `createTransferCheckedInstruction(sourceAta, mint, destAta, from, amount, decimals, [], programId)`.
   - Returns `[createATA?, transferChecked]` — length 1 or 2 depending on `includeCreateAta`.

3. **Rationale for `includeCreateAta` (optional, default `true`).**
   - Callers with multi-transfer batches to the same `(recipient, mint)` pair only need one `createATA` upfront. Second-and-later transfers pass `false` to skip the redundant emission.
   - Default `true` preserves the safe-by-default posture for single-transfer callers.

4. **Rationale for the idempotent form (`createAssociatedTokenAccountIdempotentInstruction`) instead of the probe-then-create pattern in `createTransferUnsignedTransaction`.**
   - Probe-then-create is correct when omnichain itself will compile + sign the tx — it saves rent when the ATA already exists.
   - For a caller emitting raw instructions to a downstream compiler (depositron server), the compiler runs the instructions blindly. A probe done here can race with the downstream execution — if the ATA got closed between probe and execution the transferChecked fails. The idempotent form is a no-op when the ATA exists, safe when it doesn't, and does not depend on a probe RPC.

5. **Rationale for `allowOwnerOffCurve` (optional, default `false`).**
   - `createTransferUnsignedTransaction` uses `false` today. Keeping the default matches that so existing chain-only callers see no behavior change.
   - Depositron's `SOL_INSTRUCTIONS` path wants `true` because vaults may become PDA-owned later and program-owned recipient wallets (e.g. a distribution program) are legitimate. On-chain execution failure surfaces via the settlement job's terminal FAILED state, not by refusing to build the tx.
   - Applied to BOTH source (vault) and destination (recipient) sides.

6. **Public exports.** Both methods surfaced from `solana/index.ts` via the existing `export * from './solana_chain.ts'`.

### Excluded

- **`createTransferUnsignedTransaction`** — unchanged. Direct chain-side callers keep the compiled-tx surface with its default `allowOwnerOffCurve: false` and probe-then-create.
- **`createInstructionsUnsignedTransaction`** — unchanged. Wraps arbitrary instructions into a `VersionedTransaction` and is orthogonal to this card.
- **Depositron wire encoding.** Encoding `TransactionInstruction` → `{programId: string; accounts: […]; data: string}` is a depositron DTO shape, not a chain shape. Stays in pluton-back-end.
- **No new npm dependencies.** `@solana/web3.js` and `@solana/spl-token` are already in `package.json`.
- **No changes to `Chain.base`.** Solana-only surface.

---

## Requirements

### Functional

- `buildNativeTransferInstruction(from, to, lamports)` returns exactly one instruction whose `programId` equals `SystemProgram.programId` and whose data decodes to a `Transfer` variant with `lamports === lamports`.
- `buildSplTransferInstructions({from, to, mint, amount})` (defaults: `includeCreateAta: true`, `allowOwnerOffCurve: false`) returns `[createATA-idempotent, transferChecked]` — length 2. `createATA`'s `programId` equals `ASSOCIATED_TOKEN_PROGRAM_ID`; `transferChecked`'s `programId` equals the resolved token program id (`TOKEN_PROGRAM_ID` or `TOKEN_2022_PROGRAM_ID`).
- Same call with `includeCreateAta: false` returns `[transferChecked]` — length 1.
- Same call with `allowOwnerOffCurve: true` derives BOTH source ATA and destination ATA with that flag applied. Verifiable by picking a PDA-owned `from` and asserting the derived source ATA equals the expected off-curve derivation.
- A Token-2022 mint routes through `TOKEN_2022_PROGRAM_ID` end-to-end (ATA derivation + `transferChecked` program id).

### Technical

- Both methods live on `SolanaChain` (not free functions) — consistent with `createTransferUnsignedTransaction` / `resolveMintDecimals` / `resolveTokenProgramId`.
- Public exports from `solana/index.ts`.
- Existing `createTransferUnsignedTransaction` behavior byte-identical — no shared-code refactor that changes its emitted instructions.
- Unit tests in `solana/test/solana_chain.spec.ts` (or a colocated spec) covering the five functional cases above.
- `tsc --noEmit` clean.

---

## Acceptance criteria

- Requirements above satisfied.
- Both methods documented in `README.md` (short paragraph under a "Solana raw-instruction helpers" heading).
- pluton-back-end (`v2/fix/depositron-sdk-fix`) can bump its `omnichain` dependency to the shipped version, delete `sol_instruction_builder.ts` entirely, and rewrite the SOLANA branch of `action_builder.ts` to call these two helpers — with no behavior change vs. the current in-repo builder as measured by the existing depositron unit + integration suite (35 unit tests plus the four e2e specs that touch DepositronClient).

---

## Related tickets

- **Blocks**: RIN-72 (`pluton-back-end/v2/fix/depositron-sdk-fix`, adopting depositron-client `b0cec4b` and enabling Solana on `depositronTokenTransfer`). That branch cannot merge until this ships.
- **Related**: existing `createTransferUnsignedTransaction` + `resolveMintDecimals` + `resolveTokenProgramId` on `SolanaChain` — this card reuses those internals; nothing to change there.
