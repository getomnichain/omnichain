# Changelog

All notable changes to `omnichain` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions are pre-1.0 while the repo stabilises; **minor version bumps may include breaking
changes**. Once we cut the first npm release, we switch to strict [SemVer](https://semver.org/).

Entries link the PR that shipped each change (or the commit sha for pre-PR-flow work).

---

## [Unreleased]

### Fixed

- **Solana `TransactionStatus.balanceChanges` for SPL tokens — three latent bugs in the token-balance decoder**
  ([#7](https://github.com/pluton-bridge/omnichain/pull/7)):
  - **Decimals were hardcoded to `0`.** Now surface from `uiTokenAmount.decimals` in the parsed RPC response (no extra round-trip). Consumers formatting for USD conversion or human display previously got silently wrong numbers.
  - **Mint address emitted as a wallet address** when the RPC omitted `owner` (freshly-initialised ATAs). Decoder now drops entries whose token-account owner is `null`. Matches Python's behaviour in `impl/solana/base.py:704-706`.
  - **Post-side owner is now promoted** into a pre entry that lacked one (fresh ATAs whose pre-balance meta arrives owner-less but post-balance is fully populated).
  - **Placeholder symbol** is now `UNKNOWN_<first-4-mint-chars>` (was `''`). The empty-symbol case would throw `ChainError(InvalidArgument)` at `SolanaToken` construction — never observed only because no test exercised the SPL decode path.

### Internal

- `SolanaChain.decodeBalanceChanges` renamed `_decodeBalanceChanges` (leading underscore, TS `private` dropped) so consumers stubbing `@solana/web3.js` at the jest module-mapper layer can unit-test the decoder without a `Connection`.

---

## [0.6.0] — 2026-07-22

### Breaking

- **`EvmChain` and `SolanaChain` accept `rpcUrl` at construction; `rpcEnvVar` is removed** ([#5](https://github.com/pluton-bridge/omnichain/pull/5)). Matches Sinan's Python source of truth.

  **EVM (`EvmChainInit`)**:
  - ❌ removed: `rpcEnvVar: string`
  - ✅ added: `rpcUrl?: string`

  Resolution precedence at first RPC call:
  1. constructor `rpcUrl`
  2. env `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL` (e.g. `ARBITRUM_RPC_URL`)
  3. env `EVM_<chainId>_RPC_URL`
  4. throws `ChainError(RpcNotConfigured)`

  **Solana (`SolanaChainInit`)**:
  - ❌ removed: `rpcEnvVar: string`
  - ✅ added: `defaultRpcUrl: string` — **required**, a public cluster fallback
  - ✅ added: `rpcUrl?: string`

  Resolution:
  1. constructor `rpcUrl`
  2. env `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL`
  3. `defaultRpcUrl` — **never throws** (predefined `SolanaMainnet/Testnet/Devnet` ship with `api.mainnet-beta / testnet / devnet .solana.com`)

  **UTXO** — unchanged. Tools are DI-passed with their own credentials; no chain-level RPC URL.

  ⚠️ **Env-var name drift**: `BNB Chain` now derives to `BNB_CHAIN_RPC_URL` (was `BNB_RPC_URL`). Rename your env var, use `EVM_56_RPC_URL`, or pass `rpcUrl` explicitly.

### Changed

- `ChainErrorMeta`: the RPC-not-configured error now carries `envCandidates: string[]` (the fallback chain that was tried) instead of a single `envVar: string`.
- Predefined chain factories (`Ethereum`, `Arbitrum`, `Base`, `BnbChain`, `SolanaMainnet`, `SolanaTestnet`, `SolanaDevnet`) no longer pass `rpcEnvVar` — they rely on the env-derivation fallback.

### Migration

`ChainRegistryService` (or any consumer that constructs `EvmChain` from config):

```diff
 interface EvmChainSpec {
   chainId: number;
   name: string;
   blockTimeSeconds: number;
   explorerBaseUrl: string;
   nativeSymbol: string;
-  rpcEnvVar: string;
+  rpcUrl?: string;
   supportsEip1559?: boolean;
 }
```

Anyone constructing `SolanaChain` directly (not via the predefined instances) must now supply `defaultRpcUrl` — it's required.

Test / example code should read `.env` and pass to the constructor:
```ts
const arbitrum = new EvmChain({
  chainId: 42161,
  name: 'Arbitrum',
  blockTimeSeconds: 0.25,
  explorerBaseUrl: 'https://arbiscan.io',
  nativeSymbol: 'ETH',
  rpcUrl: process.env.ARBITRUM_RPC_URL,
});
```

---

## [0.5.0] — 2026-07-05

### Added

- **`SolanaChain.buildNativeTransferInstruction(from, to, lamports): TransactionInstruction`** ([#4](https://github.com/pluton-bridge/omnichain/pull/4)) — synchronous raw-instruction builder for native SOL transfers. Wraps `SystemProgram.transfer`. Throws `ChainError(InvalidArgument)` on `lamports <= 0n` to prevent silent on-chain no-ops.
- **`SolanaChain.buildSplTransferInstructions({ from, to, mint, amount, includeCreateAta?, allowOwnerOffCurve? }): Promise<TransactionInstruction[]>`** — raw-instruction builder for SPL / Token-2022 transfers. Auto-detects Token program via `resolveTokenProgramId`. Returns `[createATA?, transferChecked]`.
  - Uses `createAssociatedTokenAccountIdempotentInstruction` (not probe-then-create) — safe when downstream compilers run instructions blindly (e.g. depositron's `SOL_INSTRUCTIONS`).
  - `allowOwnerOffCurve` applies to both source and destination ATA derivation. Defaults to `false`, matching existing chain-side callers.
  - Off-curve throw wrapped as `ChainError(InvalidAddress)` with a discoverable message pointing at the `allowOwnerOffCurve` escape hatch. Empty spl-token error is no longer opaque.

### Rationale

Enables consumers (depositron `SOL_INSTRUCTIONS` action type) to build instructions server-side without leaking `@solana/web3.js` and `@solana/spl-token` into application repos.

---

## [0.4.0] — 2026-07-05

### Added

- **Multi-output UTXO transfers** via optional `outputs?: UtxoTransferOutput[]` on `CreateUtxoTransferOptions` ([#3](https://github.com/pluton-bridge/omnichain/pull/3)). A single call can now emit multiple recipient outputs (payouts, batching, dust consolidation). Single-recipient callers unaffected (existing `to`/`amount` fields still supported).

---

## [0.3.0] — 2026-06-27

### Added

- **`SolanaChain.createInstructionsUnsignedTransaction({ from, instructions, priorityFeeMicroLamportsPerCu?, computeUnitLimit?, feePayer? })`** ([86f3cd4](https://github.com/pluton-bridge/omnichain/commit/86f3cd4)) — wraps a caller-supplied instruction list into a fully-formed `UnsignedSolanaTransaction` (MessageV0, fresh blockhash, VersionedTransaction envelope, optional ComputeBudget wiring). Caller retains responsibility for instruction correctness / signer constraints / ATA creation / decimals validation.
- **`SolanaTransferOptions.feePayer`** ([b8b12a6](https://github.com/pluton-bridge/omnichain/commit/b8b12a6)) — sponsor / fee-payer pubkey distinct from the sender. When set, the compiled tx names the sponsor as `payerKey` and as the funding `payer` for prepended `createAssociatedTokenAccount` instructions. Sender remains the SPL ATA owner / native-SOL source. Caller signs with both keypairs.

### Fixed

- **`AddressFactory.addressFor` now dispatches Solana chainIds to `SolanaAddress`** ([#2](https://github.com/pluton-bridge/omnichain/pull/2) / [9400321](https://github.com/pluton-bridge/omnichain/commit/9400321)) — previously fell back to EVM on any non-EVM chainId.

---

## [0.2.0] — 2026-06-16

### Added

- **`Chain.verifyMessageSignature({ message, signer, signature }): Promise<boolean>`** — new abstract method on `Chain`, implemented across EVM / Solana / UTXO. Third-party signature verification (no key required).
  - **EVM**: `ethers.verifyMessage` (EIP-191 personal_sign), normalises both sides through `getAddress` before comparing.
  - **Solana**: Node built-in `crypto.verify('ed25519', …)` against the signer's raw pubkey decoded via `bs58`. Accepts signature in hex (with/without `0x`) or base58 (Phantom convention).
  - **BTC**: `bitcoinjs-message.verify` keyed off `params.networkInfo.messagePrefix`. `checkSegwit=true` accepts P2WPKH and P2SH-P2WPKH alongside legacy P2PKH.
  - Pure verification — no RPC. Fails closed (returns `false`, never throws) on any malformed input across all three chains.

### Added — tooling

- **`code-review/` directory + `.claude/skills/omnichain-card/SKILL.md`** ([#1](https://github.com/pluton-bridge/omnichain/pull/1)) — CLI-driven pre-push code reviewer + task-card generator (three-mode workflow). Reads local branches only, never `origin/*`. Every card gets its own `cards/<slug>/` directory holding `description.md` and per-iteration `diff_<N>.diff` / `review_<N>.md` logs.
  - `make_card.py fetch --issue <ID> --slug <slug>` — pull a YouTrack ticket body verbatim.
  - `make_card.py draft --description "<text>" --slug <slug>` — draft a card via `claude -p`.
  - `make_card.py post --slug <slug> --project RIN --summary "<title>"` — post an approved local card as a new YouTrack issue.
  - `review.py --source <branch> --target <branch> --card <slug>` — run the reviewer; exit code 1 on Critical findings.

### Breaking (subclass surface)

- Adding `verifyMessageSignature` as `abstract` on `Chain` is a source-break for any consumer subclass. All three in-repo subclasses implement it; no external `Chain` subclasses were observed in pluton or depositron at time of merge.

---

## [0.1.0] — 2026-06-15 (initial extraction)

### Added

- **Initial extraction of the chain SDK from depositron** ([c1d4fd8](https://github.com/pluton-bridge/omnichain/commit/c1d4fd8)) as a service-agnostic library, consumed via git submodule by pluton-back-end and depositron.
- `Chain`, `Token`, `Address`, `UnsignedTransaction`, `TransactionStatus`, `NetworkType`, `ChainError` / `ChainErrorKinds`, `Priority` base primitives.
- EVM: `EvmChain`, `EvmAddress` (EIP-55), `EvmToken` (native + ERC-20), `EvmGasEstimate`, `UnsignedEvmTransaction`. Pre-baked chains: Ethereum, Arbitrum, Base, BnbChain. `suggestGas(priority)` via `eth_feeHistory` p25/p50/p90 sampling.
- Solana: `SolanaChain`, `SolanaAddress`, `SolanaToken`, `UnsignedSolanaTransaction`. Pre-baked mainnet/testnet/devnet. `createTransferUnsignedTransaction` for native SOL and SPL / Token-2022 with automatic mint owner detection. `suggestPriorityFeeMicroLamports(priority)` via `getRecentPrioritizationFees`.
- UTXO/BTC: `UtxoChain`, `BtcChain` with ordinal / rune / rare-sat filtering, per-capability tool interfaces (`UtxoProvider`, `UtxoRawTransactionProvider`, `UtxoFeeEstimator`, `UtxoBroadcaster`, `UtxoChainTipProvider`), BnB + accumulator coin selection, RBF support, OP_RETURN memos. Litecoin and Dogecoin factories.
- TON: `TonAddress` only (chain-level TON support deferred).
- `AddressFactory` + `NetworkType` registry for chain-agnostic address dispatch.
- Fixed at [84f3aab](https://github.com/pluton-bridge/omnichain/commit/84f3aab): test assertions using ERC-20 identifier instead of symbol.

---

## Legend

- **Breaking** — requires consumer code changes to build after upgrading.
- **Added** — new public API surface, backward-compatible.
- **Changed** — existing behaviour changed in a way consumers may notice.
- **Fixed** — bug that produced wrong output; consumers should upgrade to receive correct output.
- **Internal** — implementation-only change; no consumer-visible surface change.
