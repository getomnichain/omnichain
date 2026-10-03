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
- `raw_data` is built exactly like tronpy: current timestamp, 60 s expiration, TAPoS reference from the latest solid block (`wallet/getnodeinfo`). The txID and the account permission come from `wallet/getsignweight`.
- `transaction.canonicalTransaction` parses the wire JSON into the 12-contract discriminated union from `helpers/transaction.py` (`parseTronCanonicalTransaction`).

## Signing and broadcasting

```ts
const wallet = TronWallet.fromMnemonic(mnemonic); // m/44'/195'/0'/0/0 (BIP-44 secp256k1)
const signed = await wallet.signTransaction(transaction, TronMainnet);
const response = await TronMainnet.broadcastSignedTransaction(signed);
```

- Signatures are tronpy's: RFC 6979 recoverable `r || s || recid` over the txID, appended to the transaction's signature list (like tronpy, signing mutates the transaction). Messages use the TIP-191 `"\x19TRON Signed Message:\n"` keccak hash.
- `broadcastSignedTransaction` never throws: node rejections such as `DUP_TRANSACTION_ERROR`, `SERVER_BUSY` or `BLOCK_UNSOLIDIFIED` come back as `broadcastError` with the txID kept. The TS `Chain.broadcast` adapter accepts the signed JSON and throws for every rejection. `DUP_TRANSACTION_ERROR` is thrown as `RpcError`, not `BroadcastRejected`: the node may already hold the transaction, so check its status before re-signing, as Python's warning says.
- External signers sign `transaction.txId` and attach the signature with `transaction.transaction.setSignature([...])`.
- `TronWallet.handleTransactionPrerequisite` handles `TronApproveTransactionPrerequisite`. It reads the current allowance, skips if it is enough, and otherwise approves (25 TRX fee limit). For USDT-style tokens it first resets the allowance to 0 and waits three blocks; these are tokens in `ZERO_RESET_APPROVAL_TRC20_ADDRESSES` or prerequisites with `requiresZeroResetFirst`.

## Reading state

- `getAssetBalance(asset, owner)` — TRX from `wallet/getaccount` (0 for an unknown account), TRC-20 from `balanceOf`.
- `getTransactionStatus(hash, { filteredWallets, filteredAssets })` merges three sources, like Python:
  - `TransferContract` entries;
  - internal transactions (`callValueInfo`);
  - TRC-20 `Transfer` logs;
  - plus the fee debited from the first contract's owner.
  
  Unknown TRC-20 tokens are resolved through `symbol()`/`decimals()`. `fees` is a `TronTransactionFees`, whose constructor enforces Python's rule `energyUsageTotal = energyUsage + originEnergyUsage + energyFee / getEnergyFee`.
- `simulateTransaction` dry-runs `TriggerSmartContract` through `wallet/triggerconstantcontract` and reports `energyUsed`; other contract types throw `FeatureNotSupported` (Python's `NotImplementedError`). `supportsFullTransactionSimulation` is `false`.

## Differences from omnichain-py

| Python | TS | Why |
|---|---|---|
| Any exception from `gettransactioninfobyid` (429, 5xx) is reported as `NotFound`; a failed `gettransactionbyid` is swallowed | Only "not found" maps to `NotFound`; transport and API errors throw `ChainError` | A rate limit must not look like a dropped transaction |
| `print()` debugging in `simulate_transaction` / `get_transaction_status` | Removed | Library code must not write to stdout |
| tronpy falls back to its own shared TronGrid keys | Anonymous access without a configured key | Those keys belong to the tronpy project |
| On TronGrid `403 "Exceed the user daily usage"`, tronpy raises `ApiError('rate limit! please add more API keys')` and drops the key for the rest of the process | Same text as `ChainError(RpcError)`; the key is kept for later requests | One rate-limit window must not disable the client permanently |
| `private_key_hex` / `_private_key` are plain attributes | `#private` fields; `wallet.privateKeyHex` still returns the key | `JSON.stringify` / `util.inspect` never print the key or the TronGrid API key |
| `is_base58check_address` raises `ValueError` on a bad checksum | Returns `false`; callers raise their own error | TS predicates do not throw |
| `logger.warning` for non-NORMAL `FeePriority` | No logging | The TS SDK has no logger |

`TronClient` behaves like tronpy's httpx provider: it never follows redirects, it raises httpx's `raise_for_status` text on non-2xx responses, and its timeout restarts on every received chunk. Contract calls go through `tronAbiEncodeSingle` / `tronAbiDecodeSingle`, a port of tronpy's `trx_abi` (strict eth_abi decoding, Tron addresses inside arrays and tuples). `TronTransaction.sign` refuses the payloads tronpy's `AsyncTransaction.sign` refuses, with the same texts.

Hex input (keys, signatures, txIDs, node messages) is parsed exactly like Python's `bytes.fromhex`: ASCII whitespace is skipped, `0x` is not hex, and errors report only a position. The TS `verifyMessageSignature` adapter additionally accepts TronWeb's `0x`-prefixed signatures.

`addressFor`, `@IsAddress` and `validateAddress` use one check: Python's `validate_wallet_address` followed by `format_wallet_address`, so a `T…` base58check address of 21 bytes passes (any prefix byte, as in Python) and hex / `0x` forms do not. Methods that take an address format it like Python, so they also take tronpy's hex / `0x` forms. `TRON_MAINNET_STABLECOINS_PEG` is an `AssetMap`, which looks assets up by value like a Python `dict`.

## Known upstream behaviour

- `TronTransactionFees` validates against the *current* `getEnergyFee`. A transaction executed under a different energy price fails that check. Shasta's price has changed since some historical transactions, so their status lookups fail in both SDKs.
- tronpy 0.6.2 with eth_abi 5 cannot encode or decode the `trcToken` ABI type. The selector keeps `trcToken`, and encoding raises the same `Cannot create UnsignedIntegerEncoder for type 'trcToken'` error in both SDKs.

## Known limitation

- TronGrid JSON integers above 2^53 lose precision in `JSON.parse` before they reach `BigInt`. Python's ints do not. Balances and amounts below 9,007,199,254 TRX (or 2^53 base units of a token) are exact.

## Known issues shared with omnichain-py

These are bugs in omnichain-py itself. They are kept for parity and tracked to be fixed in both SDKs:

- RIN-317 — status counts rejected internal transactions and TRC-10 `callValue` as TRX, and does not debit TRX sent as `call_value`.
- RIN-318 — the wallet signs the txID returned by the node (or found in a JSON payload) without recomputing it from `raw_data`.
