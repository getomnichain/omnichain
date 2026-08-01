# omnichain 0.3.0: complete the chain-connection surface (RIN-152 SDK scope, minimal-additions redesign)

Status: Draft

# Summary

Own the complete chain-connection surface in `@getomnichain/omnichain` so that a consumer service (gasless, depositron, rango-intents) can build any protocol flow — including EIP-7702 relayers, Solana Jito bundles, arbitrary contract calls — without importing `ethers`, `@solana/web3.js`, `@solana/spl-token`, or `bitcoinjs-lib` directly. Policy, state, jobs, retries, tip sizing, endpoint-list content, wallet custody stay in the consumer.

**Design principle: minimum new API surface.** Prefer extending existing shapes over adding methods. Every new capability that can be expressed as an optional field on `CreateTransferRequest`, an option on an existing method, or a field on `UnsignedEvmTransaction` / `TransactionStatus` / chain-config, is expressed that way. Truly new methods are added only for capabilities that have no existing home. Result: **9 new methods total, ~7 optional-field extensions** — vs the ~30-method surface Sinan's original RIN-152 implied.

Packaging + peer-dep hygiene shipped as 0.2.1 (PR #2 merged, `@getomnichain/omnichain@0.2.1` on npm registry). 0.3.0 stacks on top.

# Objective and Expected Impact

Every current `chain.getProvider().*` and `chain.getConnection().*` escape hatch in gasless (grep count: ~40 sites) becomes either (a) an optional field on a shape gasless already uses, or (b) one of a small set of new SDK methods that map 1:1 to a wire-level operation. Every direct `import { … } from 'ethers'` and `import { … } from '@solana/web3.js'` in a consumer becomes unnecessary — the SDK's typed wrappers are the only touchpoint. Adding a chain-level feature (e.g. EIP-4844 blob-carrying tx later) becomes an additional optional field on `CreateTransferRequest`, not a new method — the pattern is self-reinforcing.

# Scope

## API additions — minimal set

### Extensions to EXISTING shapes (no new methods)

**`CreateTransferRequest` gains optional fields:**
- `authorizationList?: Eip7702Authorization[]` (EVM). When present, `createTransferUnsignedTransaction` returns an `UnsignedEvmTransaction` typed as type-4 with the authorization list attached. Empty array is rejected (`InvalidArgument`).
- `addressLookupTables?: AltAccount[]` (Solana). When present, the returned `UnsignedSolanaTransaction` compiles its `MessageV0` against these ALTs, unlocking >1232-byte transactions.
- `rawCalldata?: string` (EVM only, mutually exclusive with `tokenIdentifier`). Bypasses the transfer-selector builder for arbitrary contract calls — value + calldata go straight into the unsigned tx.

**`UnsignedEvmTransaction` gains optional fields:**
- `type?: 2 | 4`. Defaults to 2 unless `authorizationList` is present, then 4.
- `authorizationList?: Eip7702Authorization[]` (carried through from the request).

**`getTransactionStatus` gains overload + option:**
- Overload: `getTransactionStatus(txHash: string | string[])` — array form returns array of statuses (Solana batch replacement).
- Option: `getTransactionStatus(hash, opts?: { wait?: boolean; timeoutMs?: number; confirmations?: number; signal?: AbortSignal })` — the wait/poll loop that today is boilerplate on the consumer side.

**`EvmTransactionStatus` gains field:**
- `blockNumber: number | null` — restored (dropped in Wave 2A, needed for consumer bookkeeping).

**Chain constructors gain optional config:**
- `EvmChain`, `SolanaChain`: `rpcUrls?: string[]` in addition to `rpcUrl?: string`. When both set, `rpcUrl` prepends. Failover on `5xx | 429 | ECONNRESET | ETIMEDOUT` is INTERNAL — zero API surface change beyond this constructor field.
- `EvmChain`: `supports7702?: boolean` (default `false`). Gates the type-4 code path AND the two 7702-specific new methods below.
- `SolanaChain`: `jito?: { url: string; keypair?: unknown } | null` (default `null`). Gates the Jito code path.

**Broadcast-related error kinds added to `ChainErrorKinds`** (no new enum type — extending existing):
- `BroadcastRejected`, `NonceTooLow`, `InsufficientFunds`, `BlockhashExpired`, `SimulationFailed`, `TransactionTooLarge`, `FeatureNotSupported`.
- Existing `RpcError` covers network / 5xx.
- Existing `InvalidArgument` covers malformed input.

### NEW methods on `Chain` — 9 total

1. **`Chain.broadcast(signed, opts?)`** — the only fundamentally new capability on `Chain` base. Accepts hex string (EVM) or bytes (Solana). Returns tx hash / signature. `opts` shape is chain-specific:
   - EVM: `{ signal?: AbortSignal }`
   - Solana: `{ skipPreflight?: boolean; maxRetries?: number; via?: 'direct' | 'jito'; signal?: AbortSignal }` — Jito path folded into the same method; `via: 'jito'` requires the chain to be constructed with `jito: {...}`.

2. **`EvmChain.getPendingNonce(address)`** — replaces `.getProvider().getTransactionCount(addr, 'pending')`. Single-purpose, no overload.

3. **`EvmChain.getDelegation(address): Promise<{ delegate: string } | null>`** — reads `eth_getCode`, parses the EIP-7702 `0xef0100<20-byte-delegate>` indicator, returns the delegate address or `null`. Fully replaces the case-by-case `getCode` handling consumers do today.

4. **`EvmChain.call({ to, data, blockTag?, from?, value?, estimateGas?: boolean }): Promise<{ result?: string; gasEstimate?: bigint }>`** — one method for `eth_call` and `eth_estimateGas`. `estimateGas: false` (default) returns `{ result }`; `estimateGas: true` returns `{ gasEstimate }`. Replaces two operations that would otherwise need separate methods.

5. **`EvmChain.buildAuthorizationDigest({ delegate, nonce, chainId }): Uint8Array`** — pure-compute digest the wallet signs for a 7702 authorization. Consumer signs externally, then passes `{ delegate, nonce, chainId, signature }` as an element in `CreateTransferRequest.authorizationList`. No `assembleAuthorization` companion — consumer inlines the object.

6. **`SolanaChain.getAccountInfo(pubkey, opts?)`** — accepts `pubkey: string | string[]`. Single form returns `SolanaAccountInfo | null`; array form returns `(SolanaAccountInfo | null)[]`. Replaces `getAccountInfo` + `getMultipleAccountsInfo` in one method via the union.

7. **`SolanaChain.getTokenAccount(owner, mint, opts?): Promise<{ ata: string; exists: boolean; balanceMr?: bigint }>`** — combines ATA derivation + existence check + balance in one call. Consumer replaces `getAssociatedTokenAddress(...) + getAccountInfo(...) + parse(...)` — three operations that always come together at gasless — with a single method.

8. **`SolanaChain.compileVersionedMessage({ payer, instructions, addressLookupTables? }): Promise<CompiledMessage>`** — for consumer-composed instruction lists (Jito bundles, 7702-parity delegate calls on Solana in the future). Returns a `CompiledMessage` object whose members are: `digestForSigning: Uint8Array`, `lastValidBlockHeight: number`, `finalizeAndSerialize(signatures: Uint8Array[]): Uint8Array`. Internally fetches the blockhash — no separate `getRecentBlockhash` method needed.

9. **`SolanaChain.getBundleStatus(bundleId): Promise<JitoBundleStatus>`** — Jito status polling. Only reachable when `chain.jito !== null`; otherwise throws `FeatureNotSupported`. `getBundleStatuses` batch is `getBundleStatus(bundleId | bundleId[])` via the same union pattern as `getAccountInfo`.

### Typed wrappers (types only, no methods)

- `Eip7702Authorization = { chainId: number; delegate: string; nonce: bigint; signature: { r: string; s: string; yParity: 0 | 1 } }` — plain data, exported from the barrel.
- `AltAccount` — opaque type alias over `@solana/web3.js`'s `AddressLookupTableAccount`. The consumer NEVER instantiates it directly; only receives it from `chain.fetchAddressLookupTable(altAddress)` (see below).
- `SolanaAccountInfo = { owner: string; lamports: bigint; data: Uint8Array; executable: boolean; rentEpoch?: bigint }` — plain data.
- `CompiledMessage` — class-shape described above.
- `JitoBundleStatus = { bundleId: string; state: 'Pending' | 'Landed' | 'Failed'; slot?: number; err?: string }` — plain data.

Wait — that says the consumer receives `AltAccount` from a fetcher. That's a NEW method too. Let me revise: fold into `getAccountInfo` returning a specialized shape when the account is an ALT — OR add a 10th method. The consumer's flow is: get the ALT, use it in `addressLookupTables`. If getAccountInfo returns bare data, the consumer would have to parse. Cleanest: one small helper.

**Correction:**

10. **`SolanaChain.fetchAddressLookupTable(altAddress): Promise<AltAccount>`** — the tenth method. Deserializes the on-chain account into an `AltAccount` typed alias. Consumers use this to feed `addressLookupTables` in `CreateTransferRequest` or `compileVersionedMessage`.

**Total new methods on `Chain`: 10.**

## What the SDK KEEPS doing exactly as today (no change)

- `createTransferUnsignedTransaction(req)` — signature unchanged; three new optional fields don't affect existing callers.
- `getBalance(owner, tokenIdentifier?)` — unchanged.
- `validateAddress` / `validateTokenIdentifier` — unchanged.
- `getChainTipHeight()` — unchanged.
- Explorer URL builders — unchanged.
- `Token.isNative()` — unchanged. Python-parity native check stays here; NO string-sentinel convention is added.
- `AssetBalanceChange` / `NestedBalanceChanges` / `TransactionStatus` subclasses — structure unchanged; only `EvmTransactionStatus.blockNumber` restored.
- All EVM factories (`arbitrumChain`, `baseChain`, …), all Solana factories, all UTXO factories — signatures unchanged (their config type gains optional fields but existing calls compile).
- `AbstractGasPricing` type surface — unchanged.
- `resolveTransferAmount` — unchanged.
- Priority enum / `FeePriority` alias — unchanged.
- `EvmParsedTransactionLog` / `isTransferLog` — unchanged.

Zero renames, zero removals, zero behavior changes on existing methods. Every existing call site in depositron continues to work byte-for-byte.

## Internal behaviors (invisible to API)

- **Multi-endpoint failover** — internal to the RPC clients. When `rpcUrls: string[]` is set (with or without `rpcUrl`), on each failing request (`5xx | 429 | ECONNRESET | ETIMEDOUT`), the client transparently retries on the next endpoint. Logs a WARN with the redacted URL on each failover. Never falls back to a public default not in the list.
- **URL redactor** — every error message / thrown `ChainError.message` / log line passes through a redactor that strips `?apiKey=…`, `?key=…`, `Authorization: Bearer …`, path-embedded keys (`/v3/<key>/`). Applied uniformly at the RPC-client seam.
- **Feature-flag guards** — 7702 methods throw `FeatureNotSupported` on chains without `supports7702: true`; Jito paths (`broadcast({via:'jito'})`, `getBundleStatus`) throw `FeatureNotSupported` when `chain.jito === null`.
- **Blockhash-expiry re-broadcast semantics** — when `broadcast` retries internally on Solana blockhash-expiry, it re-broadcasts the SAME signed bytes (never re-signs — that's a double-spend hazard). Retry cap surfaces as `BlockhashExpired` for the consumer to abandon.

## Explicitly excluded (consumer-owned)

- **Policy / orchestration** — when to use 7702 vs regular tx; when to Jito-bundle vs direct-broadcast; ALT selection per chain / per intent; endpoint-list content; retry-and-backoff strategy above the SDK-internal failover; Jito tip sizing; batch-nonce state store.
- **State / jobs** — relayer queues, receipt-poll workers, in-flight retry management, bundle-composition helpers.
- **Wallet / signer surface** — key custody, hardware-signer integration, MPC.
- **Wrapper decorators for consumer DTOs** — e.g. `@IsAddressOrNative`, native-token sentinel constants. All owned by the consumer.
- **Fee-market modeling, price feeds, cross-chain routing, quote engines** — orchestration.
- **Any extension outside EIP-7702 + Jito in this wave** — no ERC-4337, no MEV protection beyond Jito. Additional extensions get their own cards.
- **CJS smoke CI + peer-dedupe CI assertion** — regression-prevention only; separate hygiene card.
- **`decimal.js` → peer** — already cross-copy-safe via structural probe.

# Requirements

## Functional Requirements

- A consumer with `@getomnichain/omnichain` as its only chain-touching dependency can build/sign/broadcast/track any EVM tx (native, ERC-20, arbitrary calldata via `rawCalldata`, EIP-7702 via `authorizationList`), any Solana tx (native, SPL, Token-2022, arbitrary instruction list via `compileVersionedMessage`, ALT via `addressLookupTables`, Jito via `broadcast({via:'jito'})`) and any UTXO tx (unchanged).
- Every current `chain.getProvider().*` and `chain.getConnection().*` call in gasless has a corresponding SDK expression after this card (verified by post-migration grep).
- Every existing depositron call site compiles + behaves identically without code changes (verified by a snapshot of depositron's `chain` module test suite run against the new version).
- Adding a new chain to the registry requires zero SDK code change; multi-endpoint config, 7702 support, Jito config all pass through the existing constructor config plumbing.

## Technical Requirements

- All 10 new methods live on `Chain` base OR its typed subclasses (`EvmChain`, `SolanaChain`). 7702 lives on `EvmChain`; Jito lives on `SolanaChain`. Nothing lands on `UtxoChain` in this wave.
- Every new async method takes an optional `signal?: AbortSignal` in its opts.
- Wire-level types (`SolanaAccountInfo`, `AltAccount`, `CompiledMessage`, `Eip7702Authorization`, `JitoBundleStatus`) are exported from the root barrel so the consumer never imports `@solana/web3.js` / `ethers` type names.
- Every error path surfaces `ChainError` with a kind from the (extended) enum; ad-hoc `throw new Error(...)` is a review blocker.
- `ChainError.meta` MUST NOT contain raw signed tx bytes or private keys under any failure mode — enforced by a CI linter.
- Multi-endpoint failover MUST NOT silently fall through to a keyless public endpoint — endpoint order is authoritative.

# Technical Scope

## Affected Modules

- `chain.base.ts` — `broadcast(signed, opts?)` abstract, new `ChainErrorKinds` values, extended `getTransactionStatus` signature.
- `errors.ts` — enum values + helpers `isBlockhashExpiredError`, `isSimulationError`, `isNonceError`, `isTransactionTooLargeError`.
- `evm/evm_chain.ts` — `broadcast`, `getPendingNonce`, `getDelegation`, `call`, `buildAuthorizationDigest`, `blockNumber` restoration on status, `type-4` codegen in `createTransferUnsignedTransaction`, `rawCalldata` codegen.
- `evm/evm_rpc_client.ts` (new, internal) — multi-endpoint client, URL redactor.
- `evm/eip7702.ts` (new, internal) — digest computation + `0xef0100` parse.
- `solana/solana_chain.ts` — `broadcast` (with `via` folding), `getAccountInfo` (union sig), `getTokenAccount`, `compileVersionedMessage`, `fetchAddressLookupTable`, `getBundleStatus` (Jito gate), ALT plumbing inside `createTransferUnsignedTransaction`.
- `solana/solana_rpc_client.ts` (new, internal) — multi-endpoint client, URL redactor.
- `solana/solana_jito.ts` (new, internal) — Jito wire calls, race-dedupe.
- `solana/compiled_message.ts` (new) — `CompiledMessage` class + `finalizeAndSerialize`.
- `index.ts` (barrel) — export new types + kinds.
- `docs/CONNECTIONS.md` (new) — the full surface with the "escape-hatch → new SDK expression" table.
- `docs/EIP7702.md` (new) — worked example: authorization sign + type-4 transfer + delegate-code read.
- `docs/JITO.md` (new) — worked example: bundle compose + `broadcast({via:'jito'})` + `getBundleStatus` poll.
- `docs/MULTI_RPC.md` (new) — `rpcUrls` semantics + failover behavior.
- `README.md` (updated) — 0.3.0 surface.
- `CHANGELOG.md` — 0.3.0 entry with the extension summary.

## Database Changes

None. Stateless SDK.

## External Integrations

- Jito block-engine HTTP API (`mainnet.block-engine.jito.wtf` or consumer-configured URL).
- EVM JSON-RPC (any provider).
- Solana JSON-RPC (any provider).
- Internal `ethers` + `@solana/web3.js` — NOT re-exported; typed wrappers hide them.

# API Contracts

## Chain.broadcast

- **EVM**: `chain.broadcast(signedHex: string | Uint8Array, opts?: { signal?: AbortSignal }): Promise<string>` → tx hash.
- **Solana**: `chain.broadcast(serialized: Uint8Array, opts?: { skipPreflight?: boolean; maxRetries?: number; via?: 'direct' | 'jito'; signal?: AbortSignal }): Promise<string>` → signature.

Errors: `BroadcastRejected`, `NonceTooLow`, `InsufficientFunds`, `BlockhashExpired`, `SimulationFailed`, `TransactionTooLarge`, `FeatureNotSupported` (when `via: 'jito'` on a non-Jito chain), `RpcError` (network / 5xx), `InvalidArgument` (malformed input).

## createTransferUnsignedTransaction — type-4 form

```
chain.createTransferUnsignedTransaction({
  from, to, tokenIdentifier?, amount?, amountHr?, isFullBalance?, memo?,
  authorizationList: Eip7702Authorization[],  // NEW — makes it type-4
});
// -> UnsignedEvmTransaction { chainId, to, value, data, type: 4, authorizationList }
```

Guards: `authorizationList.length === 0` → `InvalidArgument`. `supports7702 !== true` on chain → `FeatureNotSupported`. Any `authorizationList[i].chainId !== chain.chainId` → `InvalidArgument` (cross-chain replay guard).

## createTransferUnsignedTransaction — arbitrary EVM call

```
chain.createTransferUnsignedTransaction({
  from, to,
  rawCalldata: '0x...',   // NEW — bypasses transfer selector
  amount?,                // native value; ERC-20 handling by-passed
});
// -> UnsignedEvmTransaction { chainId, to, value, data: rawCalldata }
```

Mutually exclusive with `tokenIdentifier`. Value MAY be present (native leg of the call).

# Acceptance Criteria

- Grep audit — `grep -r 'getProvider()\|getConnection()' gasless/backend/src` after gasless adoption card lands returns zero hits (or a single documented consumer-owned exception).
- Grep audit — `grep -r "from 'ethers'\|from '@solana/web3.js'\|from '@solana/spl-token'" gasless/backend/src` after adoption card returns zero hits.
- Depositron's chain-module test suite runs against 0.3.0 with zero code changes and stays green (baseline regression proof).
- Full test suite green (unit + integration + at least one per-family E2E).
- code_reviewer.py loop finishes with zero surviving criticals.
- Docs updated + example working code in `docs/EIP7702.md` and `docs/JITO.md`.
- `npm publish` publishes `0.3.0` on `latest` tag.
- Every one of the 10 new methods has an executable jsdoc example in its declaration.

# Security Considerations

- **RPC URL redaction** — every error message / log / thrown `ChainError.message` passes through a redactor. Keyed URL formats: `?apiKey=`, `?key=`, `Authorization: Bearer `, path-embedded `/v3/<key>/`.
- **Signed bytes must never enter logs or `ChainError.meta`** — CI linter check.
- **7702 authorization binding** — digest MUST commit to `(chainId, delegate, nonce)` per the EIP. Cross-chain replay via reused authorization is a critical bug; regression test required.
- **7702 `getDelegation` correctness** — parse must ONLY accept `0xef0100<20-byte-address>` and reject `0xef01<xx>...` for any `xx !== 0x00`, and any non-24-byte code.
- **Multi-endpoint failover MUST NOT silently fall through to a keyless public endpoint** — endpoint order is authoritative; failover moves down the list only.
- **Jito bundle rejection paths** — mapped to `BroadcastRejected` with a non-leaky message.
- **Feature-flag guards on 7702 + Jito** — a chain that doesn't opt in must NOT have those code paths reachable.

# Edge Cases

- **Solana `broadcast` blockhash-expiry** — re-broadcasts SAME signed bytes internally (never re-signs). Exhausted retries → `BlockhashExpired` — consumer decides whether to re-sign against a fresh blockhash.
- **EVM `broadcast` returning `nonce too low`** — `NonceTooLow`. Consumer's call.
- **`getPendingNonce` under multi-endpoint failover** — endpoint lag can report a nonce behind the primary. Documented: consumer must not treat pending nonce as monotonic across failover events.
- **`getDelegation` on `0xef01<xx>` where xx≠00** — reject; parse must be exact.
- **7702 authorization for chainId X submitted on chainId Y** — SDK rejects at build time before wire submit.
- **Jito bundle race** — same bundle-id submitted to two block engines; only the first success is authoritative; internal dedupe to a single terminal status.
- **Multi-endpoint failover under an in-flight raw-broadcast** — if endpoint A returns success (tx hash) but endpoint B was already partway through the same call and returns success too, both hashes MUST be equal (deterministic — same signed bytes → same hash). Test asserts.
- **ALT-referenced account not yet activated at target slot** — surfaces as `SimulationFailed` with the underlying preflight error; not `TransactionTooLarge`.
- **7702 chain with `nonce=0`** — authorization builder must produce a valid digest.
- **`rawCalldata` with a bogus selector** — SDK does NOT validate the calldata semantically; that's the consumer's responsibility. SDK only validates hex shape.

# Testing Requirements

## Unit Tests

- `broadcast` — happy path + malformed hex + oversized Solana tx + already-known-nonce + rejected preflight + `via: 'jito'` on non-Jito chain rejects.
- 7702 — digest binds `(chainId, delegate, nonce)`; cross-chain re-use produces a different digest; `getDelegation` accepts `0xef0100…` and rejects `0xef01<other>`, `0xef0200…`, arbitrary code.
- `createTransferUnsignedTransaction` with `authorizationList` — type-4 emitted; `authorizationList[i].chainId !== chain.chainId` rejected; empty list rejected.
- `createTransferUnsignedTransaction` with `rawCalldata` — value + calldata in unsigned; mutually-exclusive-with-`tokenIdentifier` guard.
- `call` — read result vs `estimateGas: true` → gasEstimate; each covers the wire happy path.
- `getAccountInfo` — single form + array form.
- `getTokenAccount` — existing ATA + missing ATA + Token-2022 owner detection.
- `compileVersionedMessage` — `digestForSigning` deterministic; `finalizeAndSerialize` reconstructs a valid VersionedTransaction the consumer can broadcast.
- `fetchAddressLookupTable` — decodes an ALT and yields it in the right shape for `addressLookupTables`.
- Multi-endpoint failover — primary 5xx → secondary tried, WARN logged, request served; all-endpoints-fail bubbles last error; no public-fallback path exercised.
- URL redactor — `apiKey` / `bearer` / path-embedded key redacted in error messages.

## Integration Tests

- End-to-end EVM: build → sign → `broadcast` → `getTransactionStatus` on Sepolia (or Arbitrum Sepolia).
- End-to-end Solana: same on devnet.
- End-to-end 7702 on a Prague-enabled testnet.
- Multi-endpoint EVM against a mock returning 429 on the primary, 200 on the secondary — assert secondary served.

## E2E Tests

- Gasless-shaped EVM 7702 `executeBatch` flow driven entirely through omnichain APIs (no `ethers` import in the E2E fixture beyond the wrapped types).
- Gasless-shaped Solana Jito bundle flow driven entirely through omnichain APIs.
- Depositron chain-module test suite run against 0.3.0 candidate — regression baseline.

## Validation Tests

- Feature-flag guards on 7702 + Jito methods.
- 7702 auth on wrong chainId rejected at build time.
- Oversized Solana tx without ALT throws `TransactionTooLarge`.

## CI Requirements

- Full jest suite green under both ESM and CJS toolchains.
- New lint rule: forbid raw signed bytes in throw sites; forbid direct `.getProvider()` / `.getConnection()` outside the two new internal RPC-client files.

# Definition of Done

- 10 new methods implemented on `EvmChain` / `SolanaChain` / `Chain` base + `errors.ts`.
- Every extension to existing shapes landed (optional fields, `blockNumber` restoration, chain-config additions, `ChainErrorKinds` values).
- Feature-flag guards on 7702 + Jito.
- URL redactor active on every RPC error path.
- Tests + docs + code_reviewer.py loop clean.
- Depositron regression baseline green.
- PR merged into `main` on `getomnichain/omnichain`.
- `scripts/release.sh minor` executed, `@getomnichain/omnichain@0.3.0` on npm.
- Consumer-side follow-up (gasless RIN-153) unblocked.

# Dependencies / Blockers

- **Prerequisite:** `@getomnichain/omnichain@0.2.1` published (DONE — merged as PR #2, on npm).
- **Blocks:** RIN-153 (gasless adoption). Nothing to start there until 0.3.0 is on npm.
- No external blockers.

# Deployment Notes

- No env vars added to the SDK.
- No infra changes.
- Consumers pin `@getomnichain/omnichain@^0.3.0` on adoption.
- Migration note in `docs/PUBLISHING.md` referencing the 0.2.x → 0.3.x delta (which is all-additive on existing surface).

# Deliverables

- `@getomnichain/omnichain@0.3.0` on npm, `latest` tag.
- `v0.3.0` tag on `getomnichain/omnichain`.
- `docs/CONNECTIONS.md`, `docs/EIP7702.md`, `docs/JITO.md`, `docs/MULTI_RPC.md`.
- Updated root `README.md` reflecting the 0.3.0 surface.
- Depositron 0.3.0 upgrade note.

# References

- Parent: [RIN-152](https://rango.youtrack.cloud/issue/RIN-152) — original gap analysis (Sinan).
- Sister card: [RIN-153](https://rango.youtrack.cloud/issue/RIN-153) — gasless adoption + policy/state/wrapper-decorator ownership.
- Prior release: `@getomnichain/omnichain@0.2.1` on npm (packaging + peer deps).
- Python parity anchor: `omnichain-py/base/base.py:576` (`broadcast_signed_transaction`).
