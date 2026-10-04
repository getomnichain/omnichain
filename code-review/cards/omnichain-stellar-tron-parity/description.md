---
id: RIN-315
title: omnichain (TS SDK) — Stellar + Tron family parity with omnichain-py
status: ready
repos: [omnichain]
---

# Summary

`@getomnichain/omnichain` (TypeScript SDK) today ships EVM, Solana, UTXO, and TON. It does not expose Stellar or Tron, while the canonical Python reference `omnichain-py` has fully modelled both families — pre-wired mainnet + testnet chains, assets, wallets, status, prerequisites, simulation, and broadcast. This task brings those two families into the TypeScript SDK at full feature parity with `omnichain-py` so consumers (pluton / rango-intents backends, solver, and external SDK users) can send, read, and simulate Stellar and Tron transactions through the same `AbstractChain` / `AbstractWallet` surface already used for the other families.

---

# Objective

The TypeScript SDK must support Stellar and Tron the same way it already supports Solana and the EVM chains. A user of the SDK must be able to create a chain instance, build and sign a transfer, broadcast it, read back its status with balance changes, and simulate it before sending — without having to drop into chain-specific libraries. This closes the last gap between the Python and TypeScript reference SDKs and unblocks every intent, deposit, and solver flow that will later touch XLM, USDC-on-Stellar, TRX, and USDT-on-Tron.

The TypeScript Stellar and Tron code must behave **exactly like the Python version**. The same inputs must give the same outputs, the same errors, the same RPC calls and the same wire formats. Requirement R0 governs every other requirement in this card.

---

# Scope

## In scope (family-level)

- Stellar: mainnet + testnet, native XLM, SAC assets (USDC, EURC), non-SAC Soroban tokens, trustlines, path-payment swap, Soroban `transfer`, SEP-53 message signing.
- Tron: mainnet + Shasta testnet, native TRX, TRC-20 (USDT, USDC), approve prerequisite with USDT zero-reset, `triggerconstantcontract` simulation, canonical-transaction JSON schemas.
- Both families: wired instances, preregistered assets, wallet classes, unsigned/signed transaction models, broadcast with dup-tolerance semantics, `getTransactionStatus` with balance changes, `simulateTransaction`, chain stablecoin peg maps, explorer URL helpers.

## Out of scope / non-goals

- No change to the public surface of EVM, Solana, UTXO, or TON chains.
- No change to `AbstractChain`, `AbstractWallet`, `AbstractUnsignedTransaction`, `AbstractAsset`, `AbstractTransactionStatus`, or any other shared base — any gap found there is a separate task, not fixed here.
- No port of Tron contract types beyond what `omnichain-py` actually surfaces today (TRC-10 transfers, voting, freeze/unfreeze, resource delegation, account-permission updates are modelled in the canonical schema but not exposed through chain factory methods — same stance here).
- No new wallet family added to `WalletFamily` beyond `STELLAR` and `TRON`.
- No change to the published SDK's package layout contract — exports `./stellar` and `./tron` are added alongside the existing `./evm`, `./solana`, `./utxo`, `./ton`; existing entry points stay byte-for-byte identical.
- No RPC provider abstraction redesign — Stellar uses `@stellar/stellar-sdk` directly (Horizon + Soroban servers); Tron uses `tronweb` directly.
- No DEX routing beyond Stellar's native path-payment (Horizon strict-send) — no external aggregator integration in this task.
- Rango or solver backend plumbing to pick up these chains is a separate task.

---

# Requirements

## R0. Exact parity with omnichain-py (governing requirement)

The TS Stellar and Tron families are a port of omnichain-py at commit `5c9d512`, together with the library code that Python delegates to (tronpy 0.6.2, stellar-sdk 13.0.0, bip-utils 2.9.3). They are **not** a re-design.

- **Must match Python:**
  - every public class, method, constant and default value;
  - every validation and error case;
  - every RPC endpoint and its parameters;
  - every balance-change rule;
  - every wire format: unsigned/signed transaction JSON, `raw_data`, XDR, signatures, derivation paths.
- **Allowed TS differences:**
  - method names are camelCased;
  - Python keyword arguments become one options object with the same names and defaults;
  - Python exceptions become `ChainError` with a matching kind.
- **Allowed TS-only code:** only what the TS `Chain` base forces, implemented as thin adapters over the Python-parity methods: `getBalance`, `createTransferUnsignedTransaction`, `broadcast`, `verifyMessageSignature`, `getChainTipHeight`, and the batch / `wait` handling of `getTransactionStatus`.
- **Approved deviations** are the ones in Part C "Deviations from the plan", including its "Accepted difference classes". Any other behavioural difference is a defect.
- **Instruction to reviewers:** compare every changed TS file against its Python counterpart in the table below and report each mismatch. Check signatures, defaults, branches, RPC calls, outputs, error messages and edge cases. A mismatch not listed in Part C is **Critical**. Deviations listed in Part C, and differences that fall in one of Part C's "Accepted difference classes", are approved and must not be reported.

The Python reference sources are copied verbatim, for the reviewer, under `code-review/cards/omnichain-stellar-tron-parity/python_reference/`:
- `omnichain-py/…` is `src/omnichain/…` plus the Stellar/Tron tests;
- `tronpy/…` is tronpy 0.6.2;
- `stellar_sdk/…` is stellar-sdk 13.0.0.

| Python source | TS port |
|---|---|
| `omnichain-py/base/base.py` (AbstractAsset, AbstractAssetBalance, ChainType, FeePriority, AbstractGasPricing, prerequisites, JSON transaction contract, AbstractUnsignedTransaction, UnsignedTransactionWithPrerequisites, AbstractSignedTransaction, AbstractBroadcastTransactionResponse, AssetBalanceChange, TransactionStatusType, TransactionSimulationStatusType, AbstractTransactionSimulationResult, AbstractTransactionStatus, AbstractChain, AbstractSignedMessage, WalletFamily, AbstractWallet, AbstractBip32StyleSingleAccountWallet, FiatCurrency) | `chain_type.ts`, `asset_balance.ts`, `transaction_prerequisite.ts`, `transaction_json.ts`, `unsigned_transaction.ts`, `signed_transaction.ts`, `transaction_simulation.ts`, `wallet.base.ts`. Pre-existing TS ports: `token.ts`, `transaction_status.ts`, `chain.base.ts`, `abstract_gas_pricing.ts`, `priority.ts` |
| `omnichain-py/chain_ids.py` | `chain_ids.ts` (unchanged; Stellar/Tron ids already present) |
| `omnichain-py/impl/stellar/chains.py` | `stellar/stellar_chains.ts` |
| `omnichain-py/impl/stellar/assets.py` | `stellar/stellar_assets.ts` |
| `omnichain-py/impl/stellar/base.py` — StellarGasPricing, STELLAR_MIN_BASE_FEE_STROOPS | `stellar/stellar_gas_pricing.ts` |
| … StellarAsset, StellarNativeAssetBalance, StellarTokenAssetBalance | `stellar/stellar_asset.ts` |
| … StellarChangeTrustLineTransactionPrerequisite, StellarChangeTrustPrerequisiteResponse, StellarUnsignedTransaction, StellarSignedTransaction, StellarBroadcastTransactionResponse, StellarTransactionFees, StellarTransactionSimulationResult, StellarSorobanTransferEvent, StellarExpertTransactionInfo, StellarTrustLine | `stellar/stellar_transactions.ts` |
| … StellarTransactionStatus | `stellar/stellar_transaction_status.ts` |
| … StellarChain, StellarSignedMessage | `stellar/stellar_chain.ts` |
| … StellarWallet | `stellar/stellar_wallet.ts` |
| `stellar_sdk/keypair.py` (SEP-53 `sign_message` / `verify_message`) | `stellar/stellar_chain.ts` `stellarMessageHash` |
| `stellar_sdk/sep/mnemonic.py` (SEP-5) | `bip39.ts` `mnemonicToSeedSep5`, `stellar/stellar_wallet.ts` `deriveSep5Ed25519Seed` |
| `omnichain-py/impl/tron/chains.py` | `tron/tron_chains.ts` |
| `omnichain-py/impl/tron/assets.py` | `tron/tron_assets.ts` |
| `omnichain-py/impl/tron/base.py` — TRC20_ABI, TRC20_TRANSFER_TOPIC, DEFAULT_* fee limits, ZERO_RESET_APPROVAL_TRC20_ADDRESSES, TronAddressUtils, TronChain, TronSignedMessage | `tron/tron_chain.ts` |
| … TronGasPricing | `tron/tron_gas_pricing.ts` |
| … TronAsset, TronAssetBalance (+ the AbstractAsset registry lookups Tron uses) | `tron/tron_asset.ts` |
| … TronApproveTransactionPrerequisite, TronHandledApprovePrerequisiteResponse, `_tron_transaction_from_json`, TronUnsignedTransaction, TronSignedTransaction, TronBroadcastTransactionResponse, TronTransactionSimulationResult | `tron/tron_transactions.ts` |
| … TronTransactionFees, TronTransactionStatus | `tron/tron_transaction_status.ts` |
| … TronWallet | `tron/tron_wallet.ts` (BIP-39 via `bip39.ts` `mnemonicToSeedBip39`, bip-utils semantics) |
| `omnichain-py/impl/tron/helpers/transaction.py` | `tron/tron_canonical_transaction.ts` |
| `tronpy/keys/__init__.py` | `tron/tron_keys.ts` |
| `tronpy/providers/async_http.py`, `tronpy/async_tron.py` (AsyncTron query methods, `_handle_api_error`) | `tron/tron_client.ts` |
| `tronpy/async_tron.py` (AsyncTransaction, AsyncTransactionBuilder, AsyncTrx.transfer) | `tron/tron_transaction_builder.ts` |
| `tronpy/contract.py`, `tronpy/async_contract.py`, `tronpy/abi.py` (ContractMethod, Tron address ABI codec) | `tron/tron_contract.ts` |
| `omnichain-py/tests/stellar/*`, `omnichain-py/tests/tron/*`, `omnichain-py/tests/test_transaction_json_serialization.py` | `stellar/test/*`, `tron/test/*`, `test/transaction_json_interop.spec.ts` (Python vectors, recorded mainnet responses and Python JSON payloads) |

## R1. Stellar chain family — wired instances and assets

- `StellarMainnet` and `StellarTestnet` chain classes exposed from `./stellar`, each wiring Horizon URL, Soroban RPC URL, explorer, Stellar Expert API, `networkPassphrase`, and chain-agnostic identifier identically to `omnichain-py`'s `impl/stellar/chains.py`.
- Chain IDs match: `CHAIN_ID_STELLAR_MAINNET = -3500`, `CHAIN_ID_STELLAR_TESTNET = -3501`.
- Env-var-driven RPC override reads: `STELLAR_<chainId>_HORIZON_URL`, `STELLAR_<chainId>_SOROBAN_RPC_URL`, `<NAME>_HORIZON_URL`, `<NAME>_SOROBAN_RPC_URL` (name derived from the chain's `name`).
- Preregistered assets available: native `XLM` (mainnet + testnet), SAC `USDC`, SAC `EURC`, non-SAC Soroban `BnUSD`, plus testnet variants. Stablecoin peg map `STELLAR_MAINNET_STABLECOINS_PEG` exported.

## R2. Stellar asset model

- `StellarAsset` extends `AbstractAsset` with fields `code`, `issuer` (nullable), `contractId`, `decimals`, `chainId`, `networkPassphrase`.
- Enforces at construction time the three valid shapes: native (`code === 'XLM'`, no issuer, native contract id), SAC (code + issuer, decimals forced to 7, deterministic contract id derived with the network passphrase), non-SAC Soroban (contract id only, custom decimals).
- Exposes `isNative()`, `isSac()`, `isNonSacSorobanToken()`, `toSdkAsset()`, static `getNativeContractId(networkPassphrase)`, and class constants `NATIVE_CODE`, `DECIMALS = 7`, `TRUST_LINE_MAX_LIMIT`, `PUBLIC_NATIVE_CONTRACT_ID`, `TESTNET_NATIVE_CONTRACT_ID`.
- Two asset-balance variants exist: `StellarNativeAssetBalance` tracking `totalHr`, `reservedHr`, `availableHr`; `StellarTokenAssetBalance` tracking a single `amountHr`.
- Chain factories: `createSacToken(code, issuer)`, `createNonSacToken(contractId)` (reads `decimals()` + `symbol()` from the Soroban contract, memoised with an LRU of size 2000). The generic `createAsset(symbol, identifier, decimals)` throws, mirroring the Python implementation.

## R3. Stellar chain surface

Must expose, with the exact behaviour documented in `omnichain-py` `impl/stellar/base.py`:

- `blockTimeSeconds = 5.0`, `chainType = ChainType.STELLAR`, lazy async Horizon and Soroban server clients.
- `getBaseFee()`, `_resolveGasPricing(gasPricing)` honouring `StellarGasPricing(baseFeeStroops)` and `FeePriority` tiers (SLOW/NORMAL = 1×, FAST = 2×, floor 100 stroops).
- `resolveAsset(identifier)` (reads `decimals()` + `name()` via Soroban simulation, parses `code:issuer` for SAC vs non-SAC).
- `getAssetBalance(asset, ownerAddress)` — Horizon balances with reserve subtraction for native XLM, Soroban `balance()` for non-SAC tokens.
- `getWalletBalance(ownerAddress)` returning a map keyed by `StellarAsset` for every classical trustline on the account.
- `getTrustLineLimit(wallet, asset)` returning `StellarTrustLine { balance, limit }`.
- `createPrerequisiteForReceivableAsset(receiveAsset, receiverAddress)` producing a `StellarChangeTrustLineTransactionPrerequisite` only when the receiver is a classic account and the asset is SAC without an existing trustline; `null` for native, non-SAC, or contract receivers.
- `buildUnsignedTransaction(sourceAccountId, operations, baseFee, memoText)`.
- `buildTokenTransferOperation(asset, sender, receiver, amountHr)` returning an `InvokeHostFunction` call to SEP-41 `transfer(from, to, amount)`.
- `createTransferTransaction(asset, amountHr, sender, receiver, isFullBalance, memoText, gasPricing)` — classical `Payment` for native/SAC-to-classic, Soroban `transfer` for everything else; memo rejected for Soroban; trustline prerequisite attached when needed.
- `createExactInSwapTransaction(sendAsset, receiveAsset, sendAmountHr, sender, receiver, slippagePercent)` — Horizon strict-send path finder + `PathPaymentStrictSend` with min-receive honouring slippage; trustline prerequisite attached when needed.
- `getTransactionStatus(txHash, filteredWallets?, filteredAssets?)` — Horizon tx + ledger lookup; for Soroban invokes Soroban RPC first, falls back to Stellar Expert API; decodes memo from envelope XDR; handles `ENVELOPE_TYPE_TX_FEE_BUMP`, `ENVELOPE_TYPE_TX_V0`, `ENVELOPE_TYPE_TX`; derives `fees: StellarTransactionFees { feeStroops, feePayer }`; builds balance changes via `_effectsToBalanceChanges` (classical) or `getBalanceChangesFromDiagnosisEvents` (Soroban).
- `supportsFullTransactionSimulation(unsignedTx) → true`; `simulateTransaction(tx, sender, filteredWallets?, filteredAssets?)` — Soroban: delegate to Soroban `simulateTransaction` + diagnostic events, carry `min_resource_fee`; Classical: predict from the operation list and add the fee delta.
- `broadcastSignedTransaction(signedTx)` — Horizon `submitTransaction(envelope)`; on exception preserves `txHash` and `broadcastError`.
- `verifySignature(publicKey, message, signedMessage)` classmethod — `Keypair.fromPublicKey(G…).verifyMessage(message, Buffer.fromHex(signature))` using the SEP-53 message hash.
- `getAccountNextSequence(walletAddress)` — load account via Horizon, return `BigInt(sequence) + 1n`.
- `_muxedToClassic(address)` helper handling `M…` muxed accounts (via `MuxedAccount.fromAccount`) and classic `G…`.
- Address validation: `validateWalletAddress` accepts `G…` (ed25519) and `M…` (muxed); `validateAssetIdentifier` accepts `C…` contract ids. Explorer URL helpers mirror the Python conventions.

## R4. Stellar transaction, status, and simulation models

- `StellarGasPricing extends AbstractGasPricing { chainType, baseFeeStroops: number }`.
- `StellarUnsignedTransaction extends AbstractUnsignedTransaction` carrying intent (source account id, operations, base fee, optional memo) rather than an envelope; `buildTransactionEnvelope(chain)` resolves sequence + base fee at build time, builds via `TransactionBuilder`, sets a 300-second time bound, calls `sorobanServer.prepareTransaction` for Soroban operations; rejects memo for Soroban `InvokeHostFunction`; serialises operations and memo as base64 XDR via `toJson`/`fromJson`; exposes `isSorobanInvokeContractTransaction`.
- `StellarSignedTransaction extends AbstractSignedTransaction { signedXdr, networkPassphrase }`; `txHash` is derived from `TransactionEnvelope.fromXDR(signedXdr, passphrase).hashHex()`.
- `StellarBroadcastTransactionResponse extends AbstractBroadcastTransactionResponse { chain, txHash, broadcastError }`.
- `StellarTransactionFees { feeStroops: number, feePayer: string }`.
- `StellarTransactionSimulationResult extends AbstractTransactionSimulationResult { fees, transactionType, memo }`.
- `StellarTransactionStatus extends AbstractTransactionStatus { horizonPagingToken, fees, memo }`; static factories `successful`, `failed`, `pending`, `notFound`.
- `StellarSorobanTransferEvent { fromAccount, toAccount, tokenContractId, tokenContractSacCode?, tokenContractSacIssuer?, amountMr: bigint }`.
- `StellarExpertTransactionInfo { id, hash, ledger, ts, protocol, body, meta, result }` (all XDR strings).
- `StellarTrustLine { balance: Decimal, limit: Decimal }`.
- `StellarChangeTrustLineTransactionPrerequisite { chainId, code, issuer, limit, walletAddress }` + `StellarChangeTrustPrerequisiteResponse { skipped, txHash }`.

## R5. Stellar wallet

- `StellarWallet extends AbstractBip32StyleSingleAccountWallet` with `chainType = ChainType.STELLAR`, `walletFamily = WalletFamily.STELLAR`.
- Constructor `new StellarWallet(secretSeed: string)` validates `StrKey.isValidEd25519SecretSeed`, derives `keypair = Keypair.fromSecret`, `address = keypair.publicKey`.
- Static `StellarWallet.fromMnemonic(mnemonic, derivationPath = "m/44'/148'/0'", passphrase = "")`; `derivationPath(purpose=44, coinType=148, account=0, change=0, index=0)` returns `m/44'/148'/<account>'` and rejects any non-SLIP-0010-Ed25519 input (change/index must be 0).
- `ensureMinimumTrustLine(chain, code, issuer, limit)` — reads current limit, submits a `ChangeTrust` if needed.
- `closeTrustLine(chain, code, issuer)` — asserts zero balance then submits `ChangeTrust(limit=0)`.
- `handleTransactionPrerequisite(prerequisite, chain)` dispatches on `StellarChangeTrustLineTransactionPrerequisite`.
- `signTransaction(transaction, chain)` → builds envelope + signs → `StellarSignedTransaction`.
- `requestTestnetFaucetStroops()` → Friendbot `https://friendbot.stellar.org/?addr=…`.
- `signMessage(message)` → `StellarSignedMessage { signature: hex }` using `keypair.signMessage` (SEP-53).
- `verifySignature(message, signedMessage)` delegates to `StellarChain.verifySignature`.

## R6. Stellar family-specific primitives (parity-critical)

- Trustline reserve math on native XLM: `available = total − (2 + subEntryCount + numSponsoring − numSponsored) × 0.5 XLM`.
- `TRUST_LINE_MAX_LIMIT = "922337203685.4775807"`.
- Memo text only; rejected on Soroban `InvokeHostFunction`.
- Soroban diagnostic-event decoding for SEP-41 `transfer` topics producing `StellarSorobanTransferEvent[]`, including SAC-vs-non-SAC asset resolution via `name()` on the token contract.
- Three-way transaction data source for Soroban historical queries: Soroban RPC → Stellar Expert API fallback.
- Horizon effects → balance-changes aggregation with the specific `account_created` + `account_credited` dedup rule for Soroban native transfers.
- `createExactInSwapTransaction` honours `slippagePercent` as a hard minimum-receive bound and does not model slippage in balance-change prediction.

## R7. Tron chain family — wired instances and assets

- `TronMainnet` and `TronShastaTestnet` chain classes exposed from `./tron`, each wiring RPC URL and explorer identically to `omnichain-py`'s `impl/tron/chains.py`.
- Chain IDs match: `CHAIN_ID_TRON_MAINNET = 728126428`, `CHAIN_ID_TRON_SHASTA = 2494104990`.
- Env-var-driven RPC override reads: `TRONGRID_API_KEY`, `<NAME>_RPC_URL`, `TRON_<chainId>_RPC_URL`.
- Preregistered assets: native `TRX`, `USDT` (mainnet `TR7NHqj…`), `USDC` (mainnet `TEkxiTe…`), Shasta `USDT` (`TG3XXyE…`), Shasta `TRX`.
- `TRON_ASSETS_REQUIRING_ZERO_RESET_APPROVAL` exported, defaults to `[TRON_USDT]`; `TRON_MAINNET_STABLECOINS_PEG` map exported.

## R8. Tron asset model

- `TronAsset extends AbstractAsset` with fields `chainId`, `symbol`, `contractAddress` (nullable base58check `T…`), `decimals`.
- Native: `symbol === 'TRX'`, decimals = 6, no contract address. TRC-20: non-empty base58check contract address.
- `isNative()` returns `contractAddress === null`.
- Constants: `NATIVE_DECIMALS = 6`.
- `TronAssetBalance extends AbstractAssetBalance { amountHr: Decimal }`.
- Chain factory `getTrc20Asset(symbol, contractAddress, decimals)` builds a TRC-20 `TronAsset`.
- `TRC-10` is representable in the canonical transaction (`TransferAssetContract`) but has no `TronAsset` factory and is not surfaced by `getAssetBalance` / `createTransferTransaction` — same stance as Python.

## R9. Tron chain surface

Must expose, with the exact behaviour documented in `omnichain-py` `impl/tron/base.py`:

- `blockTimeSeconds = 3.0`, `chainType = ChainType.TRON`, lazy async tronweb client with `TRONGRID_API_KEY`.
- `getAssetBalance(asset, ownerAddress)` — `getAccountBalance` for native, `balanceOf(owner)` for TRC-20.
- `createTransferTransaction(asset, amountHr, sender, receiver, isFullBalance, gasPricing, memo?)` — native via `trx.transfer`, TRC-20 via `contract.transfer(…).with_owner(sender).fee_limit(…)`; `isFullBalance` reserves `DEFAULT_TRX_FEE_LIMIT_SUN = 300_000` for native; optional memo attached as an on-chain `data` field.
- `_resolveGasPricing(gasPricing)` honouring `TronGasPricing { feeLimitSun: number }`; non-NORMAL `FeePriority` tiers log a warning (Tron has no fee market).
- `getChainParameters()` cached (LRU 1) returning `{ energyFee: number }` from `getChainParameters.getEnergyFee`.
- `supportsFullTransactionSimulation(unsignedTx) → false`.
- `simulateTransaction(tx, sender, filteredWallets?, filteredAssets?)` — only `TriggerSmartContract` entries supported via `wallet/triggerconstantcontract`; returns `(status, energyUsed, error)`; other contract types throw `NotImplementedError`; `balanceChanges` always `{}`.
- `getTransactionStatus(txHash, filteredWallets?, filteredAssets?)` — `getTransactionInfo` + `getTransaction`, reads `receipt.result` / `result`, builds `TronTransactionFees`, inclusion time from `blockTimeStamp`, aggregates balance changes via `_balanceChangesFromInfo`.
- `broadcastSignedTransaction(signedTx)` — tronweb `signed_transaction.broadcast()`; on `DUP_TRANSACTION_ERROR` / `SERVER_BUSY` / `BLOCK_UNSOLIDIFIED` preserve `txHash` from the signed object (txid is fixed at build time).
- `verifySignature(publicKey, message, signedMessage)` classmethod — `PublicKey.verifyMsg(Buffer.from(message), Signature(Buffer.fromHex(sig)))`; accepts `PublicKey` or hex.
- `_toBase58CheckAny(address)` tolerant normaliser handling base58check `T…`, 21-byte hex `0x41…`, and bare 20-byte hex (log topic suffix — prepends `41`).
- `_parseTrc20TransferLog(log)` ABI-decoded Transfer event into `{ contract, from, to, value }` using topic `TRC20_TRANSFER_TOPIC = "ddf252ad…b3ef"`.
- `TronAddressUtils.isHex(s)`, `TronAddressUtils.hexToVisible(hex)` statics.
- Address validation: `validateWalletAddress` and `validateAssetIdentifier` accept base58check `T…` via `isBase58CheckAddress`.

## R10. Tron transaction, status, simulation, and prerequisite models

- `TronGasPricing extends AbstractGasPricing { chainType, feeLimitSun: number }`.
- `TronUnsignedTransaction extends AbstractUnsignedTransaction { transaction }`; `txId` property returns the sha256 of `rawData` protobuf (hex). `canonicalTransaction` returns a strongly-typed `TronCanonicalTransaction` (zod discriminated-union, see R12). `toJson`/`fromJson` round-trip via the underlying `AsyncTransaction.to_json()` equivalent without a network call.
- `TronSignedTransaction extends AbstractSignedTransaction { signedTransaction }`; `txId` / `txHash` identical (both fixed at build time); `toJson`/`fromJson` round-trip full JSON including `raw_data`, `txID`, `signatures`, `permission`.
- `TronBroadcastTransactionResponse extends AbstractBroadcastTransactionResponse { chain, txHash, broadcastError }`.
- `TronTransactionSimulationResult extends AbstractTransactionSimulationResult { energyUsed?: number }`.
- `TronTransactionFees { feeInSun, energyUsage, energyFee, originEnergyUsage, energyUsageTotal, netUsage, netFee, energyPenaltyTotal, chainParamGetEnergyFee }` with a cross-field validator enforcing `energyUsageTotal === energyUsage + originEnergyUsage + energyFee / chainParamGetEnergyFee`.
- `TronTransactionStatus extends AbstractTransactionStatus { fees? }`; static factories `successful`, `failed`, `pending`, `notFound`.
- `TronApproveTransactionPrerequisite { chainId, asset: TronAsset, walletAddress, spenderContractAddress, amount: bigint, requiresZeroResetFirst: boolean }` (asserts non-native).
- `TronHandledApprovePrerequisiteResponse { skipped, txHash?, zeroResetTxHash? }`.

## R11. Tron wallet

- `TronWallet extends AbstractBip32StyleSingleAccountWallet` with `chainType = ChainType.TRON`, `walletFamily = WalletFamily.TRON`.
- Constructor `new TronWallet(privateKeyHex: string)` strips `0x`, derives `publicKey` and `address = toBase58CheckAddress(publicKey)`.
- Static `TronWallet.fromMnemonic(mnemonic, derivationPath = "m/44'/195'/0'/0/0")`; derivation uses secp256k1 BIP44 via a `@scure/bip32` equivalent; `derivationPath(purpose=44, coinType=195, account=0, change=0, index=0)` returns `m/44'/195'/<account>'/<change>/<index>` with `purpose` and `coinType` enforced.
- `handleTransactionPrerequisite(prerequisite, chain, feeLimitSun = DEFAULT_TRC20_APPROVE_FEE_LIMIT_SUN)` — checks current allowance; optionally performs USDT-style zero-reset first (by prerequisite flag OR per-chain membership in `ZERO_RESET_APPROVAL_TRC20_ADDRESSES`); sleeps `3 × blockTimeSeconds` between reset and approve; broadcasts `approve(spender, amount)` with the given fee limit.
- `signTransaction(transaction, chain)` → tronweb-equivalent in-place sign of the carried transaction object.
- `signMessage(message)` → `TronSignedMessage { signature: hex }` using `privateKey.signMsg(Buffer.from(message))`.
- `verifySignature(message, signedMessage)` delegates to `TronChain.verifySignature`.

## R12. Tron canonical-transaction schemas (`helpers/transaction.ts`)

- Enums: `TronContractType` (12 members: `TransferContract`, `TransferAssetContract`, `TriggerSmartContract`, `CreateSmartContract`, `FreezeBalanceV2Contract`, `UnfreezeBalanceV2Contract`, `DelegateResourceContract`, `UnDelegateResourceContract`, `VoteWitnessContract`, `WithdrawBalanceContract`, `AccountUpdateContract`, `AccountPermissionUpdateContract`); `TronResourceCode` (`BANDWIDTH`, `ENERGY`).
- 12 `*ContractValue` schemas + 12 `*ContractEntry` discriminated-union members with a `type` literal.
- Auxiliary schemas: `VoteWitness`, `PermissionKey`, `Permission`.
- `TronContractParameter<Value> { typeUrl, value }`.
- `TronRawData { refBlockBytes, refBlockHash, timestamp, expiration, contract, data?, feeLimit?, refBlockNum?, scripts?, auths? }` — documents TAPoS replay protection.
- `TronCanonicalTransaction { txId (alias "txID"), rawData, rawDataHex, signature: string[], permission?, ret?, visible? }`.
- All schemas built with `zod` discriminated unions; mirror pydantic's `extra="allow"` / `populate_by_name=True` by using `.passthrough()` and alias-aware shapes.

## R13. Family-specific primitives (Tron, parity-critical)

- `wallet/triggerconstantcontract` response interpretation collapses three failure modes into `(ok, energy, error)`: API-validation failure, VM-revert, or OK with energy. Must match the Python branches byte-for-byte.
- Fee receipt breakdown exposed through `TronTransactionFees` with validator — never silently dropped on partial information.
- Historical balance deltas derived from three sources merged by `_balanceChangesFromInfo`: `rawData.contract[].TransferContract`, `info.internalTransactions[].callValueInfo[].callValue`, `info.log[]` with the TRC-20 Transfer topic. Fee is debited from the first contract's owner_address.
- USDT zero-reset-first flow with the 3-block sleep is honored any time the target asset is in the per-chain reset set, even without `requiresZeroResetFirst`.
- Smart-contract call encoding for TRC-20 transfer uses a tronweb builder that produces a canonical `TriggerSmartContract` with a pre-ABI-encoded `data` field (selector + args).
- Fee-limit defaults: `DEFAULT_TRC20_TRANSFER_FEE_LIMIT_SUN = 15_000_000`, `DEFAULT_TRC20_APPROVE_FEE_LIMIT_SUN = 25_000_000`, `DEFAULT_TRX_FEE_LIMIT_SUN = 300_000`.

## R14. Public exports and tests

- `./stellar` and `./tron` subpath exports added to `package.json` alongside existing ones, with ESM, CJS, and types bundles. `./package.json` export unchanged.
- `README.md` keywords and `description` fields updated so Stellar and Tron are advertised.
- Jest test suites: `stellar/test/*.spec.ts` and `tron/test/*.spec.ts`. Each exported method must have at least a happy-path test plus one failure-mode test. Status aggregators must have round-trip tests built from fixtures captured from mainnet.
- Family-specific invariant tests mandatory: Stellar asset-shape rejection (invalid issuer, decimals mismatch), trustline reserve math on native XLM, Soroban memo rejection, SEP-10 derivation-path rejection of non-SLIP-0010 inputs; Tron address-normaliser round-trip across the three input shapes, TRC-20 Transfer-log ABI decoding, `TronTransactionFees` validator rejecting imbalanced inputs, zero-reset-first on preregistered USDT, dup-tx broadcast keeping `txHash`.
- Public exports from the two subpaths must include every type listed in R2–R5 (Stellar) and R8–R12 (Tron).

---

# Acceptance Criteria

- **AC0 (R0)** For every Python class, method and constant in the R0 table, the TS port exists and behaves the same for the same inputs. The only exceptions are the Part C deviations. This covers arguments, defaults, validation, RPC calls with their parameters, return values, raised errors and wire formats. Same-input runs of both SDKs give identical results:
  - status output for the mainnet transactions in Python's integration tests;
  - addresses and signatures from Python's unit-test mnemonic;
  - the JSON payloads.
- **AC1 (R1)** `import { StellarMainnet, StellarTestnet } from '@getomnichain/omnichain/stellar'` returns pre-wired chains whose `chainId`, `blockTimeSeconds`, Horizon URL, Soroban RPC URL, explorer, and chain-agnostic identifier match the Python `impl/stellar/chains.py` values documented in R1.
- **AC2 (R2)** `new StellarAsset({ code: 'USDC', issuer: 'GA5ZSE…', chainId: -3500, networkPassphrase })` constructs with `decimals = 7` and `contractId` deterministically derived; passing `code: 'USDC'` without an issuer and without the native constant throws.
- **AC3 (R2)** `chain.createNonSacToken('CCT4ZY…')` returns a `StellarAsset` whose `decimals` and `symbol` come from `decimals()` / `symbol()` host-function reads, cached per contract id.
- **AC4 (R3)** `chain.createTransferTransaction(xlm, 10, G_from, G_to)` returns an unsigned Payment transaction with no prerequisite; the same call with a SAC asset and a classic receiver that lacks a trustline returns one with a `StellarChangeTrustLineTransactionPrerequisite`.
- **AC5 (R3)** `chain.getTransactionStatus(classicTxHash)` on a known mainnet classical Payment returns status `Success`, inclusion time, fees `{ feeStroops, feePayer }`, balance changes matching the Python reference byte-for-byte for the same hash.
- **AC6 (R3)** `chain.getTransactionStatus(sorobanTxHash)` on a known mainnet Soroban `transfer` returns status `Success`, memo `null`, and balance changes derived from diagnostic events equal to the Python reference for the same hash.
- **AC7 (R3)** `chain.simulateTransaction(unsignedSoroban, G_sender)` returns a `StellarTransactionSimulationResult` with non-null fees including `min_resource_fee`; `simulateTransaction(unsignedClassic, G_sender)` returns balance changes predicted from the operation list plus the fee delta on the sender.
- **AC8 (R3)** `chain.broadcastSignedTransaction(signed)` on a stale sequence returns a response with `broadcastError` populated and `txHash` still present.
- **AC9 (R4)** `StellarUnsignedTransaction` with a Soroban `InvokeHostFunction` and a non-null memo throws at `buildTransactionEnvelope` with a message matching Python's assert text.
- **AC10 (R5)** `StellarWallet.fromMnemonic(mnemonic, "m/44'/148'/0'/0/0")` throws; `fromMnemonic(mnemonic, "m/44'/148'/0'")` succeeds and derives the same address as `omnichain-py` for the same mnemonic.
- **AC11 (R5)** `wallet.signMessage("hello")` returns a hex signature verifiable by `StellarChain.verifySignature(wallet.publicKey, "hello", signed)`.
- **AC12 (R6)** On a mainnet account with 3 subentries and no sponsorship entries, `chain.getAssetBalance(xlm, G_addr).amountHr` equals `total − 2.5 XLM` (base + subentries).
- **AC13 (R7)** `import { TronMainnet, TronShastaTestnet } from '@getomnichain/omnichain/tron'` returns pre-wired chains whose `chainId`, `blockTimeSeconds`, RPC URL, and explorer match the Python values documented in R7.
- **AC14 (R8)** `new TronAsset({ symbol: 'USDT', contractAddress: 'TR7NHqj…', decimals: 6, chainId: 728126428 })` constructs; passing a non-base58check contract address throws.
- **AC15 (R9)** `chain.createTransferTransaction(usdt, 1n, Tsender, Treceiver)` returns an unsigned `TriggerSmartContract` whose `data` field is `transfer(address,uint256)` ABI-encoded with the matching selector and padded arguments.
- **AC16 (R9)** `chain.getTransactionStatus(mainnetTrxTransferHash)` returns `Success`, inclusion time from `blockTimeStamp`, `fees: TronTransactionFees` whose cross-field validator passes, and balance changes matching the Python reference.
- **AC17 (R9)** `chain.getTransactionStatus(mainnetTrc20TransferHash)` returns balance changes aggregated from the TRC-20 Transfer log plus the sender's fee debit, matching the Python reference byte-for-byte.
- **AC18 (R9)** `chain.simulateTransaction(unsignedTriggerSmartContract, Tsender)` returns `(status, energyUsed, error)`; simulating any other contract type throws `NotImplementedError`.
- **AC19 (R9)** `chain.broadcastSignedTransaction(signed)` under a stubbed `DUP_TRANSACTION_ERROR` returns a response whose `txHash` equals `signed.txHash` and whose `broadcastError` is populated.
- **AC20 (R10)** `TronTransactionFees` constructed with `energyUsageTotal` that does not equal `energyUsage + originEnergyUsage + energyFee / chainParamGetEnergyFee` throws at validation.
- **AC21 (R11)** `TronWallet.fromMnemonic(mnemonic)` derives the same address as `omnichain-py` for the same mnemonic on the default `m/44'/195'/0'/0/0`; a path with `purpose != 44` or `coinType != 195` throws.
- **AC22 (R11)** On a chain whose `ZERO_RESET_APPROVAL_TRC20_ADDRESSES` includes the target asset, `handleTransactionPrerequisite(approvePrereq, chain)` with a non-zero current allowance first broadcasts `approve(spender, 0)`, waits `3 × blockTimeSeconds`, then broadcasts `approve(spender, amount)`.
- **AC23 (R12)** For each of the 12 `TronContractType` members, a transaction JSON in the shape omnichain-py accepts parses into `TronCanonicalTransaction` and round-trips via `toJson`/`fromJson` without loss, with the same result as Python. Real TronGrid JSON that omits the protobuf default `resource` or carries `actives[].type: "Active"` fails in both SDKs; that is a known issue shared with omnichain-py (see Part C), not an AC23 failure.
- **AC24 (R13)** The three failure modes of `wallet/triggerconstantcontract` (API-validation failure, VM-revert, OK) map to `(ok=false, energy=0, error)`, `(ok=false, energy>0, error)`, `(ok=true, energy>0, error=null)` respectively, matching Python's `_interpret_trigger_constant_response` branches.
- **AC25 (R14)** `require('@getomnichain/omnichain/stellar')` under CJS and `import … from '@getomnichain/omnichain/stellar'` under ESM both resolve; same for `/tron`. Types bundles are emitted. The existing `./evm`, `./solana`, `./utxo`, `./ton` exports and the root export produce byte-identical ESM output to the pre-task build.
- **AC26 (R14)** Jest suites for Stellar and Tron run under `npm test` and cover every requirement at least once; mainnet-fixture status round-trips use fixtures committed under `test/fixtures/` (not live RPC calls).

---

# Constraints & Context

## Starting points

- Reference implementation: `omnichain-py` repo, `src/omnichain/impl/stellar/` (chains.py, assets.py, base.py — ~2475 LoC total) and `src/omnichain/impl/tron/` (chains.py, assets.py, base.py, helpers/transaction.py — ~2200 LoC total). Latest `omnichain-py` commit at the time of writing is `5c9d512 Add sushi fix Update rango`.
- TypeScript reference layout: imitate the existing `./solana` subpath — `solana/solana_chain.ts`, `solana/solana_transaction_status.ts`, `solana/solana_wallet.ts`, `solana/index.ts`. Apply the same split for `./stellar` and `./tron`; the TS files are expected to be slightly larger than the Python originals (2500–3200 LoC Stellar; 2300–2800 LoC Tron).
- Preregistered-asset constants: use the exact issuer / contract addresses listed in `impl/stellar/assets.py` and `impl/tron/assets.py`.
- Address-normaliser decoding of ABI-padded TRC-20 Transfer-log topics: last 20 bytes drop the `41` prefix — see Python `_to_base58check_any` and `_parse_trc20_transfer_log`.

## Compatibility constraints

- Do not change the output of `./evm`, `./solana`, `./utxo`, `./ton`, or the root entry — those builds must remain byte-identical to the current release.
- Do not change `AbstractChain`, `AbstractWallet`, `AbstractAsset`, `AbstractAssetBalance`, `AbstractUnsignedTransaction`, `AbstractSignedTransaction`, `AbstractBroadcastTransactionResponse`, `AbstractTransactionStatus`, `AbstractTransactionSimulationResult`, `AbstractSignedMessage`, `AbstractBip32StyleSingleAccountWallet`, `AbstractGasPricing`, `FeePriority`, `ChainType`, `WalletFamily`, or `TransactionStatusType` surface in a way that affects any other chain.
- Add exactly two members to `ChainType`: `STELLAR`, `TRON`. Add exactly two members to `WalletFamily`: `STELLAR`, `TRON`.

## Dependencies / blockers

- `@stellar/stellar-sdk` and `tronweb` are new runtime dependencies; both must land in `package.json` with pinned minor versions, and their types must be exported transitively where the SDK consumer needs them.
- No cross-repo dependency; this is an SDK-only task.
- Backend / solver pickup is tracked separately and must not block the SDK release.

## References

- `code-review/cards/omnichain-stellar-tron-parity/python_reference/` — verbatim copies of every Python source listed in R0, for side-by-side review. They are not tracked in git; they were copied from `/root/dev/akash/omnichain-py` at `5c9d512` and from the tronpy 0.6.2 / stellar-sdk 13.0.0 wheels.
- `omnichain-py` `src/omnichain/impl/stellar/base.py` — authoritative Stellar reference.
- `omnichain-py` `src/omnichain/impl/tron/base.py` and `impl/tron/helpers/transaction.py` — authoritative Tron reference.
- `omnichain-py` `src/omnichain/chain_ids.py` — chain id constants.
- Stellar SDK (TS): `https://stellar.github.io/js-stellar-sdk/`.
- tronweb (TS): `https://developers.tron.network/reference/tronweb-object`.
- SEP-11 (SAC asset code), SEP-41 (Soroban token interface), SEP-53 (message signing).
- SLIP-0010 Ed25519 derivation (Stellar); BIP44 secp256k1 (Tron).

---

# Open Questions

- **Q1.** Package size budget: adding `@stellar/stellar-sdk` and `tronweb` roughly doubles the installed-size footprint. Both must ship, but should the SDK publish separate subpath packages (`@getomnichain/omnichain-stellar`, `@getomnichain/omnichain-tron`) or keep a single installable with heavy optionalDeps? Default here is single-package subpath exports, mirroring `./solana`.
- **Q2.** Soroban diagnostic-event decoding depends on Stellar Expert's historical API for the fallback path. Is the retention guarantee from Stellar Expert acceptable for the solver's reconciliation window, or should we add a secondary indexer source now?
- **Q3.** Version bump: this adds two new chain families, which under semver would be a minor bump. The requester has indicated a preference for a modest bump; the implementer should propose `0.5.1 → 0.6.0` and get confirmation before release.

<!-- ====================== PART C - DEVIATIONS ====================== -->

---

# Deviations from the plan

Decisions taken with the requester (sepehr) on 2026-10-03, before coding. They override Part A wherever the two disagree.

- **Accepted difference classes (approved by sepehr on 2026-10-04).** These kinds of difference from Python are OK and need no individual entry. Reviewers do not report the first four classes at any severity; library and RPC divergences are Minor at most:
  - **Error text and error type.** Message wording, Python exception class names and `type()` texts, and whether a failure surfaces as `ChainError` or as the underlying SDK, axios or Node error, provided both SDKs fail for the same input.
  - **Malformed or non-conforming node replies.** Replies from Horizon, Soroban RPC, TronGrid or Stellar Expert with wrong JSON types, missing or extra fields, non-JSON bodies or shapes a conforming node does not send. TS may fail, fall back or accept them differently from Python's dict access and pydantic models.
  - **Stricter input validation.** TS may reject caller input that Python accepts and builds anyway, for example invalid decimals, non-finite or out-of-range amounts, unusual derivation paths, wrong hash, key or signature lengths.
  - **Caching and request counts** that do not change any result, for example per-instance caches where Python uses a class-level `alru_cache`.
  - **Divergences that come from the underlying libraries or RPCs (approved by sepehr on 2026-10-04).** A difference that exists only because TS uses different libraries (JS stellar-sdk, js-xdr, axios, `fetch`, ethers, noble, decimal.js) than Python (Python stellar-sdk, aiohttp, httpx, tronpy, eth_abi, bip-utils, pydantic), or because of how an RPC or node behaves, is **not Critical**, and is not a merge blocker. Reviewers report it as Minor at most, unless it is a real problem as defined in the next bullet.
  - **Still Critical (real problems):** for valid caller input and well-formed node replies, any difference in what is built, signed or broadcast (amounts, fees, recipients, signatures, wire formats), or in the statuses and balance changes reported; anything that can lose funds or pay twice; and any path where a malformed reply makes TS sign or broadcast something Python would not.

- **Exact Python parity is the contract.** Every method, argument, default and behaviour of omnichain-py `impl/stellar` and `impl/tron` is ported, including `StellarWallet` and `TronWallet`.
  - Names are camelCased; Python keyword arguments become one options object.
  - TS-only code is limited to what the TS `Chain` base forces: thin adapters `getBalance`, `createTransferUnsignedTransaction`, `broadcast`, `verifyMessageSignature`, `getChainTipHeight`, and the batch form of `getTransactionStatus`.
  - The Python base types the families need are ported as new shared modules, so `AbstractChain` / `AbstractAsset` / etc. from Part A map to the existing TS `Chain` / `Token` / `TransactionStatus` / `UnsignedTransaction`.
- **No `tronweb` (R7–R13, Q1).** Python uses `tronpy`, a thin HTTP client. The port calls the same TronGrid endpoints with the same `raw_data` and takes the txID from `wallet/getsignweight`, exactly like tronpy. It uses `ethers` (secp256k1, keccak, ABI, BIP-32) and `bs58`, which the package already ships, so Tron adds no dependency.
- **`@stellar/stellar-sdk` pinned to `^15.1.0`.** v16/v17 require Node ≥ 22; the package declares Node ≥ 20. v15.1 was verified against Stellar mainnet at protocol 29 (60/60 live transactions decoded).
- **TronGrid key.** Constructor `trongridApiKey` plus `TRONGRID_API_KEY` env fallback, like Python. tronpy's bundled shared keys are not copied.
- **Python bugs fixed rather than copied (approved list).**
  - Transport/API errors on the transaction lookup during status throw `ChainError(RpcError)` instead of returning `NotFound`. This includes a failed Tron `gettransactionbyid`: Python swallows it and continues with `{}`, while TS rethrows it. The Stellar follow-up ledger and effects lookups raise the stellar-sdk error, as Python does.
  - Amount conversions are exact. This covers the hr↔mr conversion in transfers and balances and `AssetBalanceChange` in status. Python's default 28-significant-digit `Decimal` context rounds above that, so an 18-decimal amount such as `12345678901.123456789012345678` differs. Python also divides non-SAC Soroban balances with a float.
  - A Soroban RPC `getTransaction` response with no `events` object, as older RPC versions return it, falls back to Stellar Expert. Python reads `events.diagnostic_events_xdr` on `None` and raises `AttributeError`. Current RPCs return `events` without diagnostic XDR, so both SDKs fall back there.
  - Debug `print()` calls are dropped.
  - The Stellar `isFullBalance` no-op and the Tron 0.3 TRX full-balance reserve are kept as-is.
- **Bugs that are identical in both SDKs are kept for parity.** They are reported to omnichain-py and TS together as RIN-316 to RIN-319, verified on omnichain-py `5c9d512` (= PyPI 0.0.3):
  - Soroban contract spoofing;
  - Tron internal-transaction accounting;
  - signing the node-supplied txID;
  - the decimals fallback cache and unpaginated Horizon effects;
  - the muxed-receiver ID stripped to its `G…` account when a transfer is built;
  - SEP-29 checked on the base `G…` account of a muxed destination, so a memo-less payment to `M…` whose base account requires a memo is refused (a muxed ID can stand in for the memo);
  - a strict-send path query sends `source_amount` as `str(Decimal)`, so an amount below 0.000001 goes out as `1E-7`, Horizon rejects it, and dust swaps cannot be built;
  - Tron canonical parsing of real TronGrid JSON: a `resource` omitted as the protobuf default (BANDWIDTH) and `actives[].type: "Active"` fail in both SDKs.
  It is OK for TS to keep these Python behaviours in this card (approved by sepehr on 2026-10-04). They are to be resolved in both SDKs in the follow-up omnichain bug card, together with RIN-316 to RIN-319. The first five are also listed under "Known issues shared with omnichain-py" in the CHANGELOG and in `docs/stellar.md` / `docs/tron.md`.
- **Small additional divergences.**
  - No logging, because the TS SDK has no logger.
  - Secrets never leak:
    - `StellarWallet` errors never echo the secret seed.
    - Hex parsing errors report only a position, exactly like `bytes.fromhex`.
    - `StellarWallet.secretSeed`, `TronWallet.privateKeyHex`, the keypair / private key and the TronGrid API key are held in `#private` fields. The Python-named accessors still return them. `JSON.stringify` and `util.inspect` with its default custom inspection never show them; `util.inspect` with `customInspect: false` and `getters: true` reads the accessors, as for any getter. A non-JSON TronGrid reply never reaches an error text.
  - `signAndBroadcastTransaction` drops the `broad_cast` spelling slip.
  - Tron's TS `broadcast` adapter throws `BroadcastRejected` only for codes java-tron returns before accepting the transaction (`SIGERROR`, `CONTRACT_VALIDATE_ERROR`, `CONTRACT_EXE_ERROR`, `BANDWITH_ERROR`), and `TransactionTooLarge` for `TOO_BIG_TRANSACTION_ERROR`. Everything else Python returns as `broadcast_error`, including `DUP_TRANSACTION_ERROR`, `SERVER_BUSY`, `OTHER_ERROR`, unknown codes and a reply without `txid` (Python's `KeyError('txid')`), is `RpcError`, because the transaction may be on-chain. TronGrid API errors on read paths are `RpcError`. `TRANSACTION_EXPIRATION_ERROR` and `TAPOS_ERROR` are `RpcError` too: java-tron checks expiry before its duplicate check, so re-broadcasting a transaction that already landed returns them after the 60 s expiry.
  - `TronChain` and `StellarChain` construct for any chain id and never touch the network-type registry, as Python's constructors register nothing. The preset ids are seeded when `network_type` loads, so a consumer's `unregisterChain` / reclassification is kept.
  - A missing `txid` (Tron) or `hash` (Stellar) in a broadcast reply is `RpcError` with Python's `KeyError` text, in `broadcastSignedTransaction` too. The TRC-20 approve broadcast keeps tronpy's error text, uses the same Tron classification and carries the signed txid.
  - `broadcastSignedTransaction` takes the node's hash as Python does (Tron: `result.get("txid") or signed.tx_hash` with Python truthiness; Stellar: `response["hash"]`). The TS `broadcast` adapters return the hash of the signed bytes in lowercase and throw `RpcError` when the node answers a different value, compared case-insensitively.
  - A TronGrid reply that is valid JSON but not an object is `RpcError` with Python's `'<type>' object has no attribute 'get'`, without the reply. For `getaccount`, Python treats a falsy reply (`null`, `[]`, `""`) as `AddressNotFound` (balance 0); TS throws instead. Soroban JSON-RPC replies for `simulateTransaction` and `getTransaction` are read like stellar-sdk Python's `_post` (`getAccount` for an explicit `accountId` still goes through the JS SDK): the HTTP status is ignored, the envelope is validated like `Response[Any]` / `Error`, a set `error` is `SorobanRpcErrorResponse` (`RpcError`) with the server's message, `code` and `data`, and the result is validated like `SimulateTransactionResponse` / `GetTransactionResponse` (pydantic lax ints for `minResourceFee`). Soroban transport errors are `RpcError` with their own message. A Soroban `getTransaction` reply that fails Python's `GetTransactionResponse` model falls back to Stellar Expert, as in Python.
  - Stellar's TS `createTransferUnsignedTransaction` adapter can only return a transaction, so it refuses a transfer whose trustline prerequisite is still pending (same check as Python's `ensure_minimum_trust_line`) instead of dropping it.
  - Stellar's TS `broadcast` adapter maps a Horizon `400` on submit (`tx_bad_seq`, `tx_failed`, …) to `BroadcastRejected` with the result codes. A SEP-29 memo-required refusal is also `BroadcastRejected`, because stellar-sdk raises it before sending anything. Timeouts and other HTTP failures stay `RpcError`, because the transaction may still land. A `200` without `hash` is Python's `KeyError('hash')`, returned as `broadcastError` and thrown as `RpcError`.
  - Tron's TS `verifyMessageSignature` adapter also accepts a `0x`-prefixed (TronWeb) signature. `TronChain.verifySignature` keeps Python's `bytes.fromhex` parsing.
  - A TronGrid `403 "Exceed the user daily usage"` raises tronpy's `ApiError('rate limit! please add more API keys')` text as `RpcError`. tronpy also drops the key from its provider, so every later request fails the same way until restart. TS keeps the key, so later requests are retried normally.
  - The canonical-transaction schemas (R12) use a hand-written validator equivalent to the pydantic models instead of `zod`, so Tron adds no dependency.
  - A zero amount in a classic Stellar operation (`Payment`, `PathPaymentStrictSend`), which comes from a zero transfer or `slippageTolerancePercent = 100`, raises `ChainError(InvalidArgument)` at build time. Python builds the operation and the network rejects it at submit. A Soroban `transfer` of zero or a negative amount builds as in Python. All other amount errors use the `raise_if_not_valid_amount` texts of Python's stellar-sdk. Fee-bump envelopes are rejected with Python's `Unexpected EnvelopeType: 5.` in `fromXdr`, `broadcast` and the Stellar Expert status path.
  - The TS predicates `isBase58CheckAddress` / `isHexAddress` return `false` where tronpy's raise `ValueError`. Callers throw their own error, as in Python.
  - Python `type(x)` in messages renders as `<class 'Name'>` with no module path. Reprs of SDK objects that have no TS equivalent are shortened: the Stellar operations list prints its length.
  - `AssetBalanceChange.upsert` (the shared TS base used by every family) drops rows whose net change is zero. Python keeps them.
- **TS-only address factory (not bound by Python parity).**
  - `addressFor` and `validateAddress` use one check for Tron: Python's `validate_wallet_address` followed by `format_wallet_address`. A `T…` base58check address of 21 bytes passes, as in Python; hex and `0x…` forms are rejected. Methods that take an address format it as Python does.
  - Stellar `G…` / `M…` addresses are validated with an SDK-free StrKey check, verified to agree with stellar-sdk. This keeps `@IsAddress` / `addressFor` from loading `@stellar/stellar-sdk`.
- **Python value semantics where JS differs.**
  - Assets used as map keys (`*_STABLECOINS_PEG`, `getWalletBalance`) go through `AssetMap`, which looks keys up by value like a Python `dict` (`chain_id`, `symbol`, `identifier`, `decimals`).
  - `TronAsset` / `StellarAsset` accept an empty symbol, like Python. `Token` keeps rejecting it for the other families.
- **Python runtime semantics ported as shared helpers.** Every TS behaviour below was checked against the library itself, with fixtures generated by CPython 3.12 / pydantic 2.13 / tronpy 0.6.2 / eth_abi 5.2:
  - `bytes.fromhex`, `str.encode` / `bytes.decode('utf-8')` (strict errors with CPython's messages; BOM kept; lone surrogates refused), `int(s, 16)`, `repr` / `str` / `type()`, `float.__repr__`, `json.dumps` (`toJsonStr` takes Python's `indent` / `separators` / `sort_keys` / `ensure_ascii` options and is byte-identical to `to_json_str`), `dict[key]` KeyError text, pydantic lax `int`.
  - tronpy's `trx_abi` (`tronAbiEncodeSingle` / `tronAbiDecodeSingle`): eth_abi's strict decoder (pointer validation, padding, booleans, UTF-8), its encoder type checks and texts, and tronpy's address codec applied inside arrays and tuples. `trcToken` fails exactly as in tronpy.
  - tronpy's `AsyncTransaction` payload handling: `sign` refuses what tronpy refuses (missing / non-integer `expiration`, non-string or non-32-byte `txID`, non-list `signature`, permission without `keys`) with tronpy's texts, and a high-s signature recovers the same key as libsecp256k1.
  - httpx transport: no redirects (3xx raise with httpx's `raise_for_status` text), and a timeout restarted on every received chunk like httpx's per-read timeout. httpx's separate write / pool timeouts have no `fetch` equivalent.
  - Stellar transport: stellar-sdk Python's `AiohttpClient` limits (GET 11 s, POST 33 s, at most 9 redirects because aiohttp's `max_redirects=10` raises on the 10th, no environment proxy), and aiohttp's 300 s default for Stellar Expert. The Stellar Expert call uses `fetch`, which follows up to 20 redirects. Horizon submit posts the envelope and reads `hash` without decoding `result_xdr`, as Python does.
  - The JS `Asset` constructor uppercases `xlm`; credit assets are built with the exact code and operation assets are read from the XDR, as stellar-sdk Python keeps the code.
  - Python's JSON envelope rules: registry by class, `issubclass` check, "does not implement from_json", duplicate-type error, and KeyError on a missing payload key.
  - Python errors become `ChainError` of the matching kind carrying Python's message text. TS has no exception classes per Python type.
- **Differences JS forces (cannot be mirrored).**
  - `decimal.js` normalises trailing zeros and exponents, so stellar-sdk's exponent rule (`Decimal('1.00000000')` or `'1E+8'` rejected) is applied to the value's decimal places instead.
  - JSON numbers: JS cannot tell `1` from `1.0`, so integral floats print and validate as ints (pydantic rejects the float `1e20`; TS accepts it as an int). Integer-like object keys are ordered first by JS, which `pyRepr` / `pyJsonDumps` cannot undo for objects parsed from JSON.
  - `ZERO_RESET_APPROVAL_TRC20_ADDRESSES` holds `"chainId:address"` strings because a JS `Set` has no tuple equality.
  - tronpy's module-level helpers are exported with a `tron` qualifier (`tronKeccak256`, `tronSha256`, `isTronAddress`, `hashTronMessage`). Python reaches them as `tronpy.keys.*`, but the TS root namespace is shared with the EVM family.
  - The TS unsigned base class predates this card and is named `UnsignedTransaction`, so its "is not a …" message names it rather than `AbstractUnsignedTransaction`.
  - Soroban `prepareTransaction` failures are classified like stellar-sdk Python: a simulation error raises `PrepareTransactionException`'s text as `SimulationFailed`, and a transport error is `RpcError`.
- **Key derivation inputs (TS kept stricter, reported).** Whenever both sides derive, the seeds are identical. Tron (bip-utils): TS accepts U+FEFF anywhere in the mnemonic, including a prefix, as a separator, and rejects `\x1c`–`\x1f` and `\x85` separators; Python's `str.split()` does the opposite. Tron derivation paths with a trailing newline, Unicode digits or an index ≥ 2^31 are rejected; Python accepts them, and bip-utils silently maps account 2^31' to 0'. Copying that would let a typo derive a different wallet. Stellar (SEP-5): a path with Unicode digits is rejected, where Python accepts it; a trailing newline and an index ≥ 2^31 are rejected by both.
- **Known TS limitation (reported, not changed in this card).** TronGrid JSON integers above 2^53 lose precision in `JSON.parse` before they reach `BigInt`. Python's ints do not.
- **Shared base additions (overrides the "no change to shared bases" non-goal).** The Python base types listed in R0 are added as new modules. `UnsignedTransaction` gains Python's JSON contract: `toJson` / `toJsonStr` throwing `FeatureNotSupported` where not implemented, plus a polymorphic `fromJson`. `NetworkType` gains `STELLAR`, and `addressFor` parses Tron and Stellar addresses. All of this is additive; the EVM / Solana / UTXO / TON behaviour is unchanged.
- **Version 0.6.0** (Q3 resolved by the requester).
- **Q2** stays as Python has it: Stellar Expert is the fallback source. Today's Soroban RPC exposes diagnostic events at the top level rather than under `events`, so in practice both SDKs use Stellar Expert for Soroban history.

# Verification performed

- **Wallet vectors.** All Python key and signature vectors (Stellar SEP-5 addresses + SEP-53 signatures; Tron BIP-44 addresses + tronpy message signatures) match byte for byte.
- **Status parity.**
  - Stellar mainnet: 5/5 of Python's mainnet status cases produce identical full output from both SDKs. The sixth is beyond SDF Horizon's ~1 year retention and is `NotFound` in both.
  - Tron mainnet: 4/4 mainnet cases replayed through Python and TS from the same recorded RPC responses produce identical output, and Python issued no request TS did not.
- **JSON wire format.** TS reproduces Python's payloads byte for byte and reads them back.
- **Live Stellar testnet.**
  - Classic transfer with memo, trustline open / skip / close through the wallet prerequisite flow, and a Soroban transfer to a contract (prepare, simulate, sign, broadcast, status).
  - Both live transactions produce identical output from Python and TS.
  - A transaction built by TS, signed by Python's `StellarWallet` from JSON and broadcast by TS landed successfully.
- **Live Tron mainnet.** Balance reads, `resolveAsset`, USDT and TRX unsigned builds, USDT `triggerconstantcontract` simulation with real energy. The live transaction's canonical parse is identical in Python and TS.
- **Review round 2 fixes:**
  - `toJsonStr` text is compared with omnichain-py's own `to_json_str` output for 28 option combinations.
  - TronGrid broadcast over real HTTP: a body reset after the 200 headers, a stalled body and a cross-origin 307 are all `RpcError`, and the redirect target receives nothing.
  - tronpy-generated fixtures: 36 ABI decode + 26 encode cases, 13 `sign` failure modes plus tronpy's exact signature, 8 high-s recovery vectors, 47 pydantic integers, 1,600+ CPython codec / `int` / `repr` / `json.dumps` / `float` cases.
- **Review round 1 fixes, checked against the real libraries:**
  - `bytes.fromhex`, `repr()` / `str()` and tronpy's exception texts are asserted from fixtures that CPython 3.12, tronpy 0.6.2 and eth_abi 5.2 generated. This includes `trcToken`, which tronpy cannot encode.
  - The SDK-free StrKey check agrees with stellar-sdk on 42,005 random and mutated inputs.
  - The Horizon (`getBaseFee`, `400` / `504` submit) and TronGrid (headers, solid-block fallback, revert texts) paths are tested over real local HTTP, through each SDK's own HTTP client.

# Follow-ups raised

- The Python `TronTransactionFees` validator uses the current energy price, so historical transactions executed under a different price fail status decoding in both SDKs. Several Shasta transactions fail this way, including the one in Python's own Shasta test. This should be fixed in omnichain-py first, then ported.
- Python reads Soroban diagnostic events from `events.diagnosticEventsXdr`, but current RPCs return them at the top level, so the Soroban RPC path is effectively dead in both SDKs. This should be fixed in omnichain-py first, then ported.
- The Stellar input design (Soroban deposit contract with intent id, TG t-6633) will need typed memos (ID/hash) and generic contract invocation. That is a separate card; Python only supports text memos today.
