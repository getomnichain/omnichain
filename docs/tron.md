# Tron

`@getomnichain/omnichain/tron` is a port of omnichain-py's `impl/tron` (`chains.py`, `assets.py`, `base.py`, `helpers/transaction.py`) together with the parts of `tronpy` it relies on (HTTP provider, transaction builder, TRC-20 contract calls, keys). There is no `tronweb` dependency: the same TronGrid HTTP endpoints tronpy calls are called directly, with `ethers` for secp256k1/keccak/ABI and `bs58` for addresses.

The family is imported from `@getomnichain/omnichain/tron` only. Like Python's `import omnichain`, the root entry does not load it.

## Chains and assets

| Export | Value |
|---|---|
| `TronMainnet` | chain id `728126428`, RPC `https://api.trongrid.io`, explorer `https://tronscan.org` |
| `TronShastaTestnet` | chain id `2494104990`, RPC `https://api.shasta.trongrid.io`, explorer `https://shasta.tronscan.org` |
| `TRON_TRX`, `TRON_USDT`, `TRON_USDC` | mainnet native and TRC-20 (6 decimals) |
| `TRON_SHASTA_TRX`, `TRON_SHASTA_USDT` | Shasta counterparts |
| `TRON_ASSETS_REQUIRING_ZERO_RESET_APPROVAL` | `[TRON_USDT]` |
| `TRON_MAINNET_STABLECOINS_PEG` | `USDC → USD`, `USDT → USD` |

Block time is 3 s. The RPC URL resolves like Python: constructor `rpcUrl`, then `<NAME>_RPC_URL`, then `TRON_<chainId>_RPC_URL`, then the default. The TronGrid key comes from the constructor `trongridApiKey` or the `TRONGRID_API_KEY` environment variable, and is sent as `Tron-Pro-Api-Key` only to `trongrid` endpoints. tronpy's bundled shared keys are not copied; without a key TronGrid allows about 3 requests per second.

`TronAsset` covers native TRX (`symbol: 'TRX'`, 6 decimals, no contract) and TRC-20 tokens (base58check contract address). Every constructed `TronAsset` is registered so status decoding can reuse known token metadata without an RPC call, as Python's asset registry does.

## Moving funds

```ts
import { Decimal } from 'decimal.js';
import { TronMainnet, TRON_USDT, TronWallet } from '@getomnichain/omnichain/tron';

const { transaction } = await TronMainnet.createTransferTransaction({
  asset: TRON_USDT,
  amountHr: new Decimal('748'),
  senderAddress: sender,
  receiverAddress: receiver,
});
```

- Native TRX builds a `TransferContract`. With `isFullBalance: true` the amount is reduced by 0.3 TRX (`DEFAULT_TRX_FEE_LIMIT_SUN`).
- TRC-20 builds a `TriggerSmartContract` calling `transfer(address,uint256)` with a 15 TRX `fee_limit` (`DEFAULT_TRC20_TRANSFER_FEE_LIMIT_SUN`), or the `feeLimitSun` of an explicit `TronGasPricing`. `FeePriority` has no effect on Tron.
- `memo` is stored hex-encoded in `raw_data.data`.
- `raw_data` is built like tronpy: current timestamp, 60 s expiration, TAPoS reference from the latest solid block (`wallet/getnodeinfo`). The txID is computed locally: `sha256` of the protobuf-encoded `raw_data` (`transaction.rawDataHex`). `wallet/getsignweight` is called only when `permissionId(...)` is set, and its txID must equal the local one. Building therefore costs one node call.
- `TronTrx.buildTransaction(type, value)` builds `TransferContract`, `TriggerSmartContract` (any calldata and `call_value`), `FreezeBalanceV2Contract` and `DelegateResourceContract`, with `.memo()`, `.feeLimit()`, `.expiration()` and `.withOwner()`. These four are the contract types the local encoder supports; TRC-10 fields (`call_token_value`, `token_id`) must be 0.
- `transaction.canonicalTransaction` parses the wire JSON into the 12-contract discriminated union from `helpers/transaction.py` (`parseTronCanonicalTransaction`).

## Signing and broadcasting

```ts
const wallet = TronWallet.fromMnemonic(mnemonic); // m/44'/195'/0'/0/0 (BIP-44 secp256k1)
const signed = await wallet.signTransaction(transaction, TronMainnet);
const response = await TronMainnet.broadcastSignedTransaction(signed);
```

- Signatures are tronpy's: RFC 6979 recoverable `r || s || recid` over the txID, appended to the transaction's signature list (like tronpy, signing mutates the transaction). Messages use the TIP-191 `"\x19TRON Signed Message:\n"` keccak hash.
- Signing recomputes the txID from `raw_data` and signs only that. A carried `txID` or `raw_data_hex` that does not match `raw_data`, an unsupported contract type, or (without a permission) a key that is not the transaction's owner is refused with `InvalidArgument` before the key is used.
- Broadcasting re-checks the txID the same way before anything is sent, then requires the node's reply to name that txID (`RpcError` otherwise). A signed transaction can be stored with `signed.toJsonStr()` and re-broadcast later with `chain.broadcast(stored)` or `broadcastSignedTransaction(TronSignedTransaction.fromJson(stored))`: it is sent exactly as stored, with the same txID. A stored copy that was altered is refused with `InvalidArgument` and never reaches the node.
- `broadcastSignedTransaction` never throws: node rejections such as `DUP_TRANSACTION_ERROR`, `SERVER_BUSY` or `BLOCK_UNSOLIDIFIED` come back as `broadcastError` with the txID kept. A reply without `txid` is Python's `KeyError('txid')`. The TS `Chain.broadcast` adapter accepts the signed JSON and throws. It throws `BroadcastRejected` only for the codes java-tron returns before accepting the transaction (`SIGERROR`, `CONTRACT_VALIDATE_ERROR`, `CONTRACT_EXE_ERROR`, `BANDWITH_ERROR`) and `TransactionTooLarge` for `TOO_BIG_TRANSACTION_ERROR`. Everything else, including `DUP_TRANSACTION_ERROR`, `SERVER_BUSY`, `OTHER_ERROR`, unknown codes and a reply without `txid`, is `RpcError`: the transaction may be on-chain, so check its status and re-broadcast the same signed bytes rather than re-signing, as Python's warning says. `TRANSACTION_EXPIRATION_ERROR` and `TAPOS_ERROR` are `RpcError` too: java-tron checks expiry before its duplicate check, so re-broadcasting a transaction that already landed returns them after the 60 s expiry.
- `TronChain` constructs for any chain id (Nile, private networks) and never touches the network-type registry, as Python's constructor registers nothing.
- `broadcastSignedTransaction` and the `broadcast` adapter return the signed txID (lowercase). A node reply naming a different txID, compared case-insensitively, is an `RpcError`.
- Loading a TRC-20 contract checks the `getcontract` reply like tronpy's `AsyncContract`: a `bytecode` that is not hex and an `abi` that is not an object raise tronpy's texts before any other call.
- A TronGrid reply that is valid JSON but not an object fails like Python's `payload.get` (`'str' object has no attribute 'get'`) as `RpcError`, without echoing the reply.
- External signers sign `transaction.txId` and attach the signature with `transaction.transaction.setSignature([...])`. `txId` is computed from `raw_data` and checked against any txID or `raw_data_hex` the payload carries, so a payload loaded from JSON cannot hand a signer someone else's txID: a mismatch throws `InvalidArgument`.
- `TronWallet.handleTransactionPrerequisite` handles `TronApproveTransactionPrerequisite`. It reads the current allowance, skips if it is enough, and otherwise approves (25 TRX fee limit). For USDT-style tokens it first resets the allowance to 0 and waits three blocks; these are tokens in `ZERO_RESET_APPROVAL_TRC20_ADDRESSES` or prerequisites with `requiresZeroResetFirst`.

## Reading state

- `getAssetBalance(asset, owner)` — TRX from `wallet/getaccount` (0 for an unknown account), TRC-20 from `balanceOf`.
- `getTransactionStatus(hash, { filteredWallets, filteredAssets })` merges three sources, like Python:
  - `TransferContract` entries;
  - internal transactions (`callValueInfo`);
  - TRC-20 `Transfer` logs;
  - plus the fee debited from the first contract's owner.
  
  Unknown TRC-20 tokens are resolved through `symbol()`/`decimals()`. `fees` is a `TronTransactionFees`, whose constructor enforces Python's rule `energyUsageTotal = energyUsage + originEnergyUsage + energyFee / getEnergyFee`.
- Balance changes count only money that moved:
  - an internal transaction counts as TRX only if it is not `rejected`, its `note` is `call` or `suicide` (staking and resource-delegation entries are skipped), and only its `callValueInfo` entries without a `tokenId` (TRC-10) are added up;
  - the TRX a `TriggerSmartContract` sends as `call_value` is debited from the owner and credited to the contract;
  - a `Transfer` log counts as TRC-20 only with exactly three topics and one 32-byte data word, so TRC-721 transfers are skipped.
  These are the rules Clydner applies.
- Successful and failed statuses also carry, from the same two node calls:
  - `blockNumber`: the block that included the transaction;
  - `signers`: the owner account of the transaction's contract (the authorizing account, not the keys that signed under a multi-signature permission); `[]` when the raw transaction cannot be fetched;
  - `memoHex`: `raw_data.data` in lowercase hex, and `memo`: that hex decoded by `decodeTronMemo` (strict UTF-8, a leading byte-order mark dropped, `null` for no memo, invalid UTF-8 or bad hex). Clydner decodes memos the same way.
  Pending and not-found statuses carry `null`, `[]`, `null`, `null`.
- Confirmations are not on the status (`wait` and `confirmations` options stay refused). Compute them as `getChainTipHeight() − blockNumber + 1`. A poll loop should read the tip once per tick and reuse it for every transaction it checks in that tick, so confirmations cost one call per tick, not one per transaction.
- `simulateTransaction` dry-runs `TriggerSmartContract` through `wallet/triggerconstantcontract` and reports `energyUsed`; other contract types throw `FeatureNotSupported` (Python's `NotImplementedError`). `supportsFullTransactionSimulation` is `false`.

## Differences from omnichain-py

| Python | TS | Why |
|---|---|---|
| Any exception from `gettransactioninfobyid` (429, 5xx) is reported as `NotFound`; a failed `gettransactionbyid` is swallowed | Only "not found" maps to `NotFound`; transport and API errors throw `ChainError` | A rate limit must not look like a dropped transaction |
| `print()` debugging in `simulate_transaction` / `get_transaction_status` | Removed | Library code must not write to stdout |
| tronpy falls back to its own shared TronGrid keys | Anonymous access without a configured key | Those keys belong to the tronpy project |
| On TronGrid `403 "Exceed the user daily usage"`, tronpy raises `ApiError('rate limit! please add more API keys')` and drops the key for the rest of the process | Same text as `ChainError(RpcError)`; the key is kept for later requests | One rate-limit window must not disable the client permanently |
| `private_key_hex` / `_private_key` are plain attributes | `#private` fields; `wallet.privateKeyHex` still returns the key | `JSON.stringify` and the default `util.inspect` never print the key or the TronGrid API key, and a non-JSON TronGrid reply never reaches an error text |
| `is_base58check_address` raises `ValueError` on a bad checksum | Returns `false`; callers raise their own error | TS predicates do not throw |
| `logger.warning` for non-NORMAL `FeePriority` | No logging | The TS SDK has no logger |
| The txID comes from `wallet/getsignweight` and is signed as given | The txID is computed locally from the protobuf-encoded `raw_data`; a mismatching carried txID or `raw_data_hex` is refused before signing or broadcasting | A node or payload must not be able to get a signature over a different transaction. Python's fix is on RIN-328 |
| Status counts rejected internal transactions, staking/delegation entries and TRC-10 `callValue` as TRX, and does not debit `call_value` | Only real TRX and TRC-20 moves are counted (see Reading state) | Deposits must not look larger than what arrived. Python's fix is on RIN-328 |
| Status has no block number, signers or memo | `blockNumber`, `signers`, `memo`, `memoHex` | Read from data the status already fetches; no extra node calls |

`TronClient` behaves like tronpy's httpx provider: it never follows redirects, it raises httpx's `raise_for_status` text on non-2xx responses, and its timeout restarts on every received chunk. Contract calls go through `tronAbiEncodeSingle` / `tronAbiDecodeSingle`, a port of tronpy's `trx_abi` (strict eth_abi decoding, Tron addresses inside arrays and tuples). `TronTransaction.sign` keeps tronpy's texts for the refusals it shares with `AsyncTransaction.sign` (expired, permission list, signature list), and adds the local txID checks above.

Hex input (keys, signatures, txIDs, node messages) is parsed exactly like Python's `bytes.fromhex`: ASCII whitespace is skipped, `0x` is not hex, and errors report only a position. The TS `verifyMessageSignature` adapter additionally accepts TronWeb's `0x`-prefixed signatures.

`addressFor`, `@IsAddress` and `validateAddress` use one check: Python's `validate_wallet_address` followed by `format_wallet_address`, so a `T…` base58check address of 21 bytes passes (any prefix byte, as in Python) and hex / `0x` forms do not. Methods that take an address format it like Python, so they also take tronpy's hex / `0x` forms. `TRON_MAINNET_STABLECOINS_PEG` is an `AssetMap`, which looks assets up by value like a Python `dict`.

## Known upstream behaviour

- `TronTransactionFees` validates against the *current* `getEnergyFee`. A transaction executed under a different energy price fails that check. Shasta's price has changed since some historical transactions, so their status lookups fail in both SDKs.
- tronpy 0.6.2 with eth_abi 5 cannot encode or decode the `trcToken` ABI type. The selector keeps `trcToken`, and encoding raises the same `Cannot create UnsignedIntegerEncoder for type 'trcToken'` error in both SDKs.

## Known limitation

- TronGrid JSON integers above 2^53 lose precision in `JSON.parse` before they reach `BigInt`. Python's ints do not. Balances and amounts below 9,007,199,254 TRX (or 2^53 base units of a token) are exact.
