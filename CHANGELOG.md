# Changelog

All notable changes to `@getomnichain/omnichain` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

_Nothing yet. Add entries here as PRs merge; on release, rename this section to `[X.Y.Z] — YYYY-MM-DD` and open a fresh empty `[Unreleased]` above it._

---

## [0.3.4] — 2026-08-03

Bugfix.

### Fixed

- **Jito bundle auth header** — `SolanaChain.submitJitoBundle` and `SolanaChain.getBundleStatus` were sending the UUID under `Authorization: Bearer <uuid>`; the block engine's authenticated tier expects **`x-jito-auth: <uuid>`** (confirmed against Jito's own `jito-labs/jito-py-rpc` SDK). With the wrong header the block engine accepted the submit (returned a bundle id) but treated the request as unauthenticated — bundles never landed and every bundled tx timed out at the ~70s blockhash window. Regression noted in 0.3.0 Known Limitations as "verify against endpoint"; verified against production by the gasless team on 0.3.3. Now sends `x-jito-auth` at both call sites; unauthenticated (no `jito.auth` configured) still sends no auth header at all.

---

## [0.3.3] — 2026-08-02

Bugfix.

### Fixed

- **`SolanaChain.getChainTipHeight()`** returned the **slot** (`getSlot('confirmed')`) instead of the **block height** (`getBlockHeight('confirmed')`). The method's cross-family contract is a block-height accessor comparable with `getLatestBlockhash().lastValidBlockHeight`, which is a block height. On Solana `slot > blockHeight` always (currently by ~25M — slots include skipped/empty ones), so any consumer doing the standard blockhash-expiry check `getChainTipHeight() > lastValidBlockHeight` saw `true` immediately and marked every freshly-built Solana tx as expired within ~1s. Now returns `getBlockHeight('confirmed')`; the value is the same units as `lastValidBlockHeight` and the expiry math works correctly. `EvmChain.getChainTipHeight()` was already correct (returns block number).

---

## [0.3.2] — 2026-08-02

Additive minor. Closes the final gasless "only-omnichain" gap: `simulateTransaction` now exposes web3.js's `accounts` passthrough so consumers can read post-simulation account state (the primitive `measureUserPrefundViaSimulation` needs).

### Added

- **`SolanaChain.simulateTransaction(signed, opts)` — `opts.accounts?: { addresses: string[] }`**. When supplied, the return object gains an `accounts?: ({ lamports: number; data: Uint8Array } | null)[]` field in the same order as `opts.accounts.addresses`. Missing addresses in the post-sim state map to `null`. Base64 is used on the wire and decoded to `Uint8Array` for the consumer.
- Validation: empty `addresses[]` throws `InvalidArgument`; a malformed pubkey throws `InvalidAddress`.
- Back-compat: when `opts.accounts` is omitted, the return shape is unchanged from 0.3.1 (`accounts` field absent).

---

## [0.3.1] — 2026-08-02

Additive minor. Two new `SolanaChain` read primitives to unblock the gasless `RIN-153` migration finish — consumers assembling `MessageV0` locally (custom fee ix + Jito tip + ALTs merged with aggregator swap bytes) can now route every chain **read** through the SDK without being pushed into the opinionated full-builder. Local computation (compile + sign) stays consumer-side by design.

### Added

- **`SolanaChain.getLatestBlockhash(commitment?)`** — thin passthrough to `Connection.getLatestBlockhash`. Returns `{ blockhash, lastValidBlockHeight }`. Defaults to `'confirmed'`; accepts `'processed' | 'confirmed' | 'finalized'` (consumers with Jito flows should pass `'processed'` — RPC lag vs Jito's leader tip can otherwise reject a submitted bundle as `Invalid`). Transport failures wrap as `ChainError(RpcError)` with URL-redacted messages.
- **`SolanaChain.simulateTransaction(signed, opts?)`** — passthrough to `Connection.simulateTransaction`. Accepts a signed `VersionedTransaction` as `Uint8Array` or `0x`-prefixed hex; deserializes internally. Returns `{ unitsConsumed, err, logs }`. Opts: `{ sigVerify?, replaceRecentBlockhash?, commitment? }`. Input validation matches `broadcast` (rejects empty / <65 bytes / malformed hex as `InvalidArgument`). Companion to `estimateAndApplyCu`, which only sizes SDK-built transactions — this is the raw primitive for consumers that build the tx themselves.

Both methods reuse the internal `rpcWrap` sanitizer path so no keyed URL can leak through their error messages.

### Notes

- `SolanaChain.estimateAndApplyCu` and `SolanaChain.createUnsignedTransaction` continue to be the preferred paths when the SDK owns the tx build; these primitives are for the consumer-owned-build case.

---

## [0.3.0] — 2026-08-02

Complete chain-connection surface. Consumers (gasless, depositron, rango-intents, …) can now build any protocol flow — including EIP-7702 relayers, Solana Jito bundles, arbitrary contract calls — without importing `ethers`, `@solana/web3.js`, `@solana/spl-token`, or `bitcoinjs-lib` directly.

Design principle: minimum new API surface. 10 new methods total; optional-field extensions where existing shapes already covered the use case. Policy, orchestration, state, jobs, retries, tip sizing, endpoint-list content, wallet custody stay in the consumer.

### Added

#### New base method (all 3 families)

- `Chain.broadcast(signed: string | Uint8Array, opts?: BroadcastOpts): Promise<string>` — universal broadcast entry point. Returns deterministic tx hash (EVM/UTXO) or base58 signature (Solana, both `direct` and `via: 'jito'`). Handles "already-known" retries as success (safe against load-balanced provider propagation lag).

#### `EvmChain`

- `getPendingNonce(address): Promise<bigint>`
- `getDelegation(address): Promise<string | null>` — parses EIP-7702 delegation designator (`0xef0100 || <20-byte>`). Requires `supports7702: true`.
- `call({ to, data, from?, value?, blockTag?, estimateGas? }): Promise<EvmCallResult>` — read path + optional gas estimate. Revert data on `ChainError.meta.revertData`.
- `buildAuthorizationDigest({ chainId, delegate, nonce }): Uint8Array` — EIP-7702 auth digest for external signer.
- `createUnsignedTransaction({ from, to, data?, value?, authorizationList?, gasLimit?, nonce?, maxFeePerGas?, maxPriorityFeePerGas? }): Promise<UnsignedEvmTransaction>` — general-purpose builder; emits `type = 4` when `authorizationList` present, else `2` (or `0` on legacy chains).

#### `SolanaChain`

- `getAccountInfo(pubkey | pubkey[])` — single or batch.
- `getTokenAccount(owner, mint, opts?)` — returns ATA + exists/owner-safety flags; distinguishes "not found" from "hostile squat" (`InvalidArgument` on the latter).
- `fetchAddressLookupTable(address)` — for message compilation.
- `submitJitoBundle(signedTxs: Uint8Array[], opts?): Promise<string>` — returns bundle id.
- `getBundleStatus(bundleId | bundleId[])` — polls Jito for landed/failed.
- `createUnsignedTransaction({ payer, instructions, addressLookupTables? }): Promise<UnsignedSolanaTransaction>` — general-purpose builder; rejects >1232-byte txs at build time.

#### Unsigned-tx helpers

- `UnsignedSolanaTransaction.digestForSigning(): Uint8Array` — message bytes for external ed25519 signer.
- `UnsignedSolanaTransaction.finalizeAndSerialize(signatures: Uint8Array[]): Uint8Array` — attach externally-computed signatures, return wire bytes.

#### New types / interfaces

- `Eip7702Authorization { chainId, address, nonce, signature: { r, s, yParity } }`
- `CreateEvmUnsignedTransactionRequest`, `CreateSolanaUnsignedTransactionRequest`
- `EvmCallRequest`, `EvmCallResult`
- `JitoBundleStatus { bundleId, state: 'Pending' | 'Landed' | 'Failed', slot?, err? }`
- `SolanaJitoConfig { url, auth? }`
- `BroadcastOpts`, `GetTransactionStatusOpts`, `CreateUnsignedTransactionRequest`

#### New optional fields on existing shapes

- `EvmChainInit.rpcUrls?: string[]` (multi-endpoint failover deferred to 0.3.1; >1 throws at construction — fail-closed)
- `EvmChainInit.supports7702?: boolean` (default `false`)
- `EvmChainInit.nativeTransferGasLimit?`, `nativeTransferGasMultiplier?` (declarative)
- `SolanaChainInit.rpcUrls?: string[]` (same failover throw)
- `SolanaChainInit.jito?: SolanaJitoConfig`
- `SolanaChainInit.legacyRpcEnvNames?: string[]` (env-var rename compat)
- `CreateTransferRequest.addressLookupTables?: unknown[]` (Solana honors; EVM/UTXO ignore)
- `UnsignedEvmTransaction`: `type?`, `authorizationList?`, `gasLimit?`, `nonce?`, `maxFeePerGas?`, `maxPriorityFeePerGas?`
- `UnsignedSolanaTransaction.addressLookupTables?`
- `EvmTransactionStatus.blockNumber?: number`

#### `ChainErrorKinds` — 7 new kinds

- `BroadcastRejected` — chain says no; do not retry, do not re-sign
- `NonceTooLow`
- `InsufficientFunds`
- `BlockhashExpired` — safe to re-broadcast SAME signed bytes on Solana
- `SimulationFailed` — preflight rejected; revert data on `meta.revertData` (EVM)
- `TransactionTooLarge`
- `FeatureNotSupported`

#### New helpers (from `errors.ts`)

- `isBlockhashExpiredError`, `isSimulationError`, `isNonceError`, `isTransactionTooLargeError`
- `sanitizeUtxoErrMessage` (was internal; now exported)

#### `getTransactionStatus` — batch overload + wait/poll semantics

Signature now overloaded:
```ts
getTransactionStatus(hash: string, opts?: GetTransactionStatusOpts): Promise<TransactionStatus>
getTransactionStatus(hashes: string[], opts?: GetTransactionStatusOpts): Promise<TransactionStatus[]>
```

`GetTransactionStatusOpts`:
- `wait?: boolean` — poll until terminal
- `timeoutMs?: number` — **required** when `wait: true`
- `confirmations?: number` — EVM: any N ≥1; Solana: 1 or ≥32; UTXO: not supported
- `signal?: AbortSignal` — honored in poll loop

Batch: 8-way worker pool. On any per-item error, all workers abort and the promise rejects with the underlying error.

### Changed

#### Behavior changes on existing methods (subtle — audit consumer code)

- **`SolanaChain.estimateAndApplyCu`** — throws `ChainErrorKinds.SimulationFailed` (was `InvalidArgument`). Consumers switching on `.kind === InvalidArgument` around this method silently fall through. `SolanaChain.isSimulationError(err)` remains compatible.
- **`sanitizeCause`** — prefers `err.shortMessage` (ethers v6 one-liner) over `err.message` (multi-line JSON). Reduces leak surface; changes what shows up in `err.cause.message`.
- **`sanitizeMessage(msg, null)`** — no longer identity; new redactor rules run regardless of `rpcUrl`.

#### API surface additions to base class (source-breaking for external subclasses only)

- `Chain.broadcast` and the two-signature `Chain.getTransactionStatus` are `abstract`. Only breaks consumers who subclass `Chain` directly (none known today). All internal chain implementations satisfy them.

#### Build-time validation (previously deferred to broadcast/sign time)

- **`createTransferUnsignedTransaction` on Solana** — throws `TransactionTooLarge` at build time if the serialized tx > 1232 bytes (previously failed later at broadcast).
- **`createTransferUnsignedTransaction` on Solana** — wraps `MessageV0.compile` failures in `ChainError(InvalidArgument)` (previously escaped as raw `@solana/web3.js` error).
- **`createTransferUnsignedTransaction` on Solana** — routes returned bytes through `sanitizeMessage` on transport failures (was unwrapped `FetchError` — leaked keyed URLs into logs).

#### Fail-closed on unsupported options (deliberate)

Where prior code silently accepted-and-ignored, these now throw:

- **`broadcast(bytes, { signal })`** — `BroadcastOpts.signal?: never`. Compile-fails on TS; runtime throws `FeatureNotSupported` for JS. Silently ignoring signal would let a caller conclude "not sent" while the tx still lands → double-send hazard.
- **`createUnsignedTransaction({ signal })`** — same treatment.
- **`getTransactionStatus(hash, { wait: true })` without `timeoutMs`** — throws `InvalidArgument`. Unbounded polling would pin an RPC worker + connection forever.
- **`getTransactionStatus(hash, { wait: true, confirmations: N })` on Solana** where `N` is not 1 or ≥32 — throws `InvalidArgument`.
- **`getTransactionStatus(hash, { wait }|{ confirmations })` on UTXO** — throws `FeatureNotSupported`. Poll block-tip provider consumer-side.
- **`EvmChain.call({ estimateGas: true, blockTag })`** — throws `InvalidArgument`. ethers v6's `estimateGas` has no block-tag plumbing.
- **`broadcast(new Uint8Array(0))`** — throws `InvalidArgument` (all families).
- **`broadcast(bytes)` on Solana** with `< 65` or `> 1232` bytes — throws `InvalidArgument` / `TransactionTooLarge` on both `direct` and `via: 'jito'` paths.
- **`SolanaChainInit` without `chainAgnosticGenesisHash`** — TS compile error (new required field).
- **`EvmChain` constructed over a chainId already registered as non-EVM** — throws `InvalidArgument`.

#### Batch `getTransactionStatus` — no longer masks failures

Previously per-item errors were converted to `NotFound` synthesized statuses. Now: any per-item failure re-throws with an internal `AbortController` stopping the other workers. This closes a double-send hazard where a transport error on one hash caused a relayer to re-sign a mined tx.

#### `broadcast` — safer "already-known" handling

- **EVM matcher widened** for Nethermind (`AlreadyKnown`), Besu (`TRANSACTION_ALREADY_KNOWN`), Erigon/reth (`txpool: already known`, `already present`), plus generic mempool phrases.
- **No confirmation gate** — returns `keccak256(hex)` unconditionally on match. Confirmation reads on load-balanced providers (Alchemy/Infura/QuickNode round-robin) routinely hit a different backend and return null; falling into terminal `BroadcastRejected` on that path would trigger re-signs while the original tx is live.

#### UTXO `computeUtxoTxidLE` — safe bitcoinjs parse failures

Wraps `bitcoinjs-lib` parse errors on the "already-known" path in `ChainError(BroadcastRejected)` with explicit "do NOT re-sign" guidance in the message. Prior code let raw parse errors escape as non-`ChainError`.

#### EVM address normalization

`createUnsignedTransaction`, `call`, `getPendingNonce` now normalize `to`/`from`/`address` to `0x`-prefixed EIP-55 checksum form via ethers `getAddress` before storing/sending. Accepts unprefixed 40-hex bodies AND `0X`-prefixed input; wraps malformed as `ChainError(InvalidAddress)`.

#### URL redactor coverage

`sanitizeMessage` now redacts:
- Signed-bytes hex runs (128+ chars, with/without `0x` prefix)
- Base64 signed-bytes (160+ chars, e.g. Solana wire format)
- Query params: `?apiKey=`, `?api-key=`, `?api_key=`, `?token=`, `?auth=`, `?secret=`, `?access-token=`
- `Bearer <token>` (case-insensitive)
- Bare `Authorization: <val>`
- `x-api-key:` / `X-Api-Key:` / `Api-Key:` / `api_key:` headers
- Path-embedded keys under `/vN/`, `/api/`, or `/rpc/` (terminator broadened for comma, paren, semicolon, dot, quote, whitespace, end-of-string)
- Full URLs of known providers (Alchemy, Infura, QuickNode, Helius, Ankr, Blast, dRPC) with the path stripped
- Basic-auth credentials in URLs (`user:pass@host`)
- Provider key markers (`pk_`, `sk_`, `ghp_`, `gho_` prefixes)

### Fixed

- **Solana `getBundleStatus`** — robust parsing of Jito's `err` shape variants (`null` / `{ Ok: null }` / `{ Err: … }` / `'string'` / omitted / missing row). Prior code could report a failed bundle as landed on some shapes.
- **Solana Jito auth flow** — request path now honors `AbortSignal` with a bounded 15s timeout; sanitized `RpcError` on transport failure; robust HTTP-shape handling for the block-engine response.
- **`SolanaChain.rpcUrls.length > 1`** — throws at construction (fail-closed) instead of silently discarding entries.
- **`EvmChain` `already-known` detection** — deterministic hash returned even when the provider's confirmation read is served by a lagging backend (load-balanced propagation).
- **UTXO `sanitizeUtxoErrMessage`** — retains legacy hex-path key rule (`/[hex]{32,}` in URL segments), basic-auth scrubbing, and `pk_/sk_/ghp_/gho_` markers; also inherits shared sanitizer rules.
- **EVM broadcast classifier** — default terminal branch is `BroadcastRejected` (matches Solana/UTXO). Transport signals (`ECONNRESET`, `ETIMEDOUT`, rate-limit codes `-32005/-32007/-32016/-32029/429`, HTTP 5xx) branch to `RpcError`.
- **`Chain.getTransactionStatus(hash, { wait: true, timeoutMs })`** — on timeout from non-terminal state, throws `ChainError(RpcError)` with explicit "must NOT credit / must NOT re-sign" wording. Previously returned bare `NotFound`, indistinguishable from a definitive read — created a double-send hazard.

### Security

- New redactor rules close 4 key-leak paths flagged during review:
  - Query-string keys where the param name isn't literally `key` (e.g. `?auth=`)
  - `x-api-key:` header form (Helius / Alchemy / QuickNode)
  - Path-embedded keys wrapped by `(`, `)`, `,`, `;`, `.`, `"`, `'`
  - `/rpc/<key>` path segments (self-hosted providers)
- EIP-7702 `buildAuthorizationDigest` — wraps `getAddress` failures in `ChainError(InvalidAddress)` (was raw ethers `TypeError`).
- EIP-2 low-s canonical form check on EIP-7702 authorization signatures — silently-skipped non-canonical authorizations rejected at build time (prevents "tx lands, gas spent, no delegation installed" hazard).
- `sanitizeCause` prefers `err.shortMessage` — prevents ethers v6 multi-line JSON dumps from leaking signed bytes into `err.cause.message`.

### Deferred (recorded, not shipping in 0.3.0)

Ships in 0.3.1:
- Multi-endpoint RPC failover (`evm_rpc_client.ts` / `solana_rpc_client.ts` seam). `rpcUrls` field exists but `length > 1` throws.
- `AbortSignal` end-to-end. Honored in `getTransactionStatus` poll loops today; NOT in `broadcast` / `createUnsignedTransaction` / `getAccountInfo` / `getTokenAccount` / `fetchAddressLookupTable` / `getPendingNonce` / `getDelegation` (these fail-closed on `{ signal }`).

Follow-up cards:
- `SolanaChain.getBundleStatus` — dropped bundles indistinguishable from in-flight; consumer must impose polling timeout policy. Adding a fourth `'Unknown'` state (or querying `getInflightBundleStatuses` for missing rows) is a follow-up.
- Jito auth header shape — currently `Authorization: Bearer`; the block engine documents `x-jito-auth` on authenticated tiers. Verify against endpoint before wiring `jito.auth`.
- `withFeatures({ supports7702?, jito?, rpcUrl?, rpcUrls? })` clone method on registered chain factories — currently consumers must hand-rebuild frozen chain singletons to opt in to 7702 or Jito.
- Blockhash-expiry internal re-broadcast — consumer implements retry loop per safe-broadcast rule (re-broadcast SAME signed bytes, never re-prepare).

---

## [0.2.1] — 2026-08-01

Hotfix release. Zero API changes; hygiene only. Native-token sentinel handling deferred to the paired gasless card (out of SDK scope — `Token.isNative()` already covers the SDK-side native check; the `0xeeee…` string convention is a consumer-side external-interop concern).

### Added

- Dual CJS+ESM build pipeline: emits `dist/esm/` (ESM) + `dist/cjs/` (CJS) via two `tsc` configs, with per-directory `package.json` `type` overrides so Node picks the correct loader per subpath. Fixes `ERR_REQUIRE_ESM` for CJS consumers (NestJS builds target CJS by default).

### Changed

- `class-validator` and `class-transformer` moved from `dependencies` to `peerDependencies` with generous ranges (`class-validator: ^0.14 || ^0.15 || ^0.16`). Prevents duplicate copies when both gasless (0.14) and depositron (0.15) install this package — two copies silently break decorator-metadata dedupe.
- `decimal.js` stays a regular dependency (already cross-copy-safe via structural probe + toString round-trip in `chain.base.ts`).

### Security

- `.env` and `.npmrc.publish` added to `.gitignore` so npm tokens can never be committed.

## [0.2.0] — 2026-07-27

Initial npm release of `@getomnichain/omnichain`. Replaces the vendored `pluton-bridge/omnichain` git submodule for consumer repos (`depositron`, `gasless`).

### Added

- Package published to npm registry under `@getomnichain` scope with public access.
- CJS build (single-target) suitable for NestJS consumers.
- Root barrel + `/evm`, `/utxo`, `/solana` subpath exports.
- Full API surface at parity with the vendored submodule at commit `65c515002a08eceae29b5089c2ca6de83395a1fe`.

### Migration from vendored submodule

- Consumers that previously imported from `../../chain/*` (relative to `src/modules/`) now import from `@getomnichain/omnichain` (root barrel) or `@getomnichain/omnichain/evm` / `/utxo` / `/solana` for subpath-scoped imports.
- Solana chainId numbering renumbered (breaking; per-consumer SQL data migration required for any persisted Solana chainId).
- `pluton-bridge/omnichain` git submodule deprecated — do not consume.

---

[0.3.0]: https://github.com/getomnichain/omnichain/releases/tag/v0.3.0
[0.2.1]: https://github.com/getomnichain/omnichain/releases/tag/v0.2.1
[0.2.0]: https://github.com/getomnichain/omnichain/releases/tag/v0.2.0
