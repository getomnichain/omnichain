# Stellar

`@getomnichain/omnichain/stellar` is a port of omnichain-py's `impl/stellar` (`chains.py`, `assets.py`, `base.py`). Method names are camelCased, keyword arguments become one options object, and the behaviour — RPC calls, balance-change rules, fees, prerequisites, JSON wire format — is the Python behaviour. It is built on `@stellar/stellar-sdk` 15.x, the JS counterpart of Python's `stellar-sdk`.

## Chains and assets

| Export | Value |
|---|---|
| `StellarMainnet` | chain id `-3500`, Horizon `https://horizon.stellar.org`, Soroban RPC `https://mainnet.sorobanrpc.com`, explorer + Stellar Expert API `stellar.expert/explorer/public`, namespace `stellar:pubnet` |
| `StellarTestnet` | chain id `-3501`, Horizon `https://horizon-testnet.stellar.org`, Soroban RPC `https://soroban-testnet.stellar.org`, namespace `stellar:testnet` |
| `STELLAR_XLM`, `STELLAR_USDC`, `STELLAR_EURC`, `STELLAR_BNUSD` | mainnet native, SAC USDC/EURC, non-SAC Soroban BnUSD (18 decimals) |
| `STELLAR_TESTNET_XLM`, `STELLAR_TESTNET_USDC`, `STELLAR_TESTNET_EURC` | testnet counterparts |
| `STELLAR_MAINNET_STABLECOINS_PEG` | `USDC → USD`, `EURC → EUR` |

Block time is 5 s. RPC URLs resolve exactly like Python: constructor `horizonUrl` / `sorobanRpcUrl`, then `<NAME>_HORIZON_URL` / `<NAME>_SOROBAN_RPC_URL` (name upper-cased, spaces → `_`), then `STELLAR_<chainId>_HORIZON_URL` / `STELLAR_<chainId>_SOROBAN_RPC_URL`, then the defaults above.

`StellarAsset` has three shapes, validated at construction:

| Shape | Construct with | Identifier | Decimals |
|---|---|---|---|
| Native XLM | `issuer: null`, no contract id (or the network native contract id) | network native contract (`CAS3J7…` / `CDLZFC…`) | 7 |
| SAC (classic asset) | `code` + `issuer`, or `chain.createSacToken(code, issuer)` | contract id derived from code + issuer + network | 7 |
| Non-SAC Soroban token | `contractId` + `decimals`, or `await chain.createNonSacToken(contractId)` | the contract id | from the contract |

`chain.resolveAsset(contractId)` reads `decimals()` and `name()` through a Soroban simulation and returns the right shape (`"native"`, `"CODE:ISSUER"` or a plain token). `createAsset()` throws, as in Python.

## Moving funds

```ts
import { Decimal } from 'decimal.js';
import { StellarMainnet, STELLAR_USDC, StellarWallet } from '@getomnichain/omnichain/stellar';

const { transaction, prerequisites } = await StellarMainnet.createTransferTransaction({
  asset: STELLAR_USDC,
  amountHr: new Decimal('25'),
  senderAddress: sender,
  receiverAddress: receiver,
  memoText: 'invoice-42',
});
```

- Native XLM or a SAC asset paid to an account (`G…`/`M…`) becomes a classic `Payment`. Anything else — a non-SAC token, or any asset paid to a contract (`C…`) — becomes a Soroban `transfer(from, to, amount)` invocation. Soroban transfers cannot carry a memo and the call throws if one is given.
- A SAC asset paid to an account always returns a `StellarChangeTrustLineTransactionPrerequisite` for the receiver (max limit `922337203685.4775807`). The receiver's wallet handles it with `handleTransactionPrerequisite`, which skips when the line is already high enough.
- `gasPricing` takes `FeePriority` (SLOW/NORMAL = network base fee, FAST = 2×) or `new StellarGasPricing({ baseFeeStroops })`; the result is never below 100 stroops.
- `createExactInSwapTransaction` asks Horizon for strict-send paths, takes the first route and sets `destMin = destination_amount × (1 − slippage/100)` rounded half-up to the receive asset's decimals.
- The unsigned transaction holds the *intent*. `buildTransactionEnvelope(chain)` loads the sequence number, fills the base fee, applies a 300 s time bound and, for Soroban, runs `prepareTransaction`.

## Signing and broadcasting

```ts
const wallet = StellarWallet.fromMnemonic(mnemonic); // m/44'/148'/0' (SEP-5)
await wallet.handleTransactionPrerequisites(prerequisites, StellarMainnet);
const signed = await wallet.signTransaction(transaction, StellarMainnet);
const response = await StellarMainnet.broadcastSignedTransaction(signed);
if (!response.isBroadcastConfirmed) {
  // The tx may still be on-chain: check getTransactionStatus(response.txHash) before re-signing.
}
```

External signers call `transaction.buildTransactionEnvelope(chain)`, sign `envelope.hash()` and submit `envelope.toXDR()` through `chain.broadcast(xdr)` (the TS `Chain` adapter, which throws on rejection) or wrap it in `StellarSignedTransaction` for `broadcastSignedTransaction` (which never throws and returns `broadcastError`).

`StellarWallet` mirrors Python: `fromSecret`, `fromMnemonic(mnemonic, path, passphrase)` (English BIP-39 checked exactly like python-mnemonic, SLIP-0010 ed25519, hardened-only `m/44'/148'/<account>'`), `derivationPath()`, `ensureMinimumTrustLine`, `closeTrustLine`, `handleTransactionPrerequisite`, `signTransaction`, `signMessage` / `verifySignature` (SEP-53) and `requestTestnetFaucetStroops` (Friendbot).

## Reading state

- `getAssetBalance(asset, owner)` — native XLM returns the *available* balance: total minus `(2 + subentries + sponsoring − sponsored) × 0.5 XLM`. SAC assets read the trustline; non-SAC tokens call `balance()` on the contract.
- `getWalletBalance(owner)`, `getTrustLineLimit(owner, asset)`, `getAccountNextSequence(owner)`, `getBaseFee()`.
- `getTransactionStatus(hash, { filteredWallets, filteredAssets })`:
  - Classic transactions aggregate Horizon effects (`account_credited/debited`, `contract_credited/debited`, `account_created`). The starting balance of an account created by a Soroban native transfer is counted once.
  - Soroban transactions decode SEP-41 `transfer` events from diagnostic events, read from Soroban RPC when it exposes `events.diagnosticEventsXdr`, otherwise from the Stellar Expert API.
  - The fee is debited from the fee account in every successful status, regardless of the filters (Python behaviour). `memo` and `fees` are set on the status.
- `simulateTransaction({ transaction, senderWalletAddress })` — Soroban: `simulateTransaction` events + `minResourceFee`; classic: deltas predicted from the operations plus the fee.

## Differences from omnichain-py

| Python | TS | Why |
|---|---|---|
| Any Horizon error during status (429, 5xx) is reported as `NotFound` | Only a 404 is `NotFound`; other failures throw `ChainError(RpcError)` | A rate limit must not look like a dropped transaction |
| Non-SAC `getAssetBalance` divides with a float; other conversions use the 28-digit `Decimal` context | Exact decimal conversion everywhere | Avoids precision loss on 18-decimal tokens |
| Invalid secret seed error message contains the seed | Message omits the seed | Secrets never go into error strings |
| `secret_seed` / `_keypair` are plain attributes | `#private` fields; `wallet.secretSeed` still returns the seed | `JSON.stringify` / `util.inspect` of a wallet never print the seed |
| A zero `Payment` amount or `dest_min` (100 % slippage) builds, and the network rejects it at submit | `ChainError(InvalidArgument)` at build time; other amount errors use stellar-sdk's texts | stellar-sdk JS cannot build a zero operation |
| Soroban RPC response without an `events` object raises `AttributeError` | Falls back to Stellar Expert | Older RPC versions omit `events` |
| `logger.info/warning` calls | No logging | The TS SDK has no logger |

The TS `Chain` adapters (`getBalance`, `createTransferUnsignedTransaction`, `broadcast`, `verifyMessageSignature`, `getChainTipHeight`) wrap the methods above.
- `createTransferUnsignedTransaction` rejects `isFullBalance`, because Python ignores the flag and the TS request has no amount when it is set.
- `broadcast` maps a Horizon `400` on submit to `ChainError(BroadcastRejected)` with the result codes. Timeouts and other failures are `RpcError`, because the transaction may still land.

`addressFor` / `@IsAddress` validate `G…` / `M…` addresses without loading `@stellar/stellar-sdk`. `STELLAR_MAINNET_STABLECOINS_PEG` and `getWalletBalance` return an `AssetMap`, which looks assets up by value like a Python `dict`.

## Known upstream behaviour

- Soroban RPC currently returns diagnostic events at the top level of `getTransaction`, not under `events`, so Python — and therefore this port — resolves historical Soroban transactions through the Stellar Expert API.
- SDF's public Horizon keeps roughly one year of history; older transactions return `NotFound` from both SDKs.
