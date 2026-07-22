# omnichain

A service-agnostic abstraction layer for talking to blockchain networks. One
shape (`Chain`, `Token`, `Address`, `UnsignedTransaction`) covers EVM
(Ethereum / Arbitrum / Base / BNB / …), UTXO (Bitcoin / Litecoin /
Dogecoin), Solana, and TON, with the same call surface regardless of
underlying network.

This repository is the canonical source for the SDK. It is consumed by
sister services (depositron, pluton-back-end, gasless) as a git submodule
mounted at each service's own `chain` directory.

## What's in here

| Concept | File | Purpose |
|---|---|---|
| `Chain` | [chain.base.ts](../chain.base.ts) | Abstract base for any chain — exposes `getBalance`, `createTransferUnsignedTransaction`, `getTransactionStatus`, address/token validation, explorer URLs |
| `Token` | [token.ts](../token.ts) | Abstract base for an on-chain asset — `chainId`, `symbol`, `identifier` (or `NATIVE_TOKEN_IDENTIFIER`), `decimals` |
| `Address` | [address.ts](../address.ts) | Abstract address with `canonical()` + `networkType` |
| `UnsignedTransaction` | [unsigned_transaction.ts](../unsigned_transaction.ts) | Abstract base for an unsigned tx; per-chain subclasses add the bytes |
| `NetworkType` | [network_type.ts](../network_type.ts) | Enum (`EVM`, `COSMOS`, `TON`, `SOLANA`, `BTC`) + `registerNonEvmChain(chainId, type)` registry |
| `TransactionStatus` | [transaction_status.ts](../transaction_status.ts) | Polled tx state — confirmations, gas/fee paid, balance changes |
| `Priority` | [priority.ts](../priority.ts) | Shared `Priority` enum (`SLOW`/`NORMAL`/`FAST`) used by per-chain `suggestGas` / `suggestFeeRate` / `suggestPriorityFeeMicroLamports` |
| `ChainError` | [errors.ts](../errors.ts) | Module-internal error with a `kind` discriminator |
| `addressFor(chainId, raw)` | [address.factory.ts](../address.factory.ts) | Network-aware address constructor |

## Per-chain implementations

| Network | Where | What it is |
|---|---|---|
| **EVM** (Ethereum, Arbitrum, Base, BNB, …) | [evm/](../evm) | `EvmChain` over `ethers.js` v6 + ERC-20 support — see [evm.md](./evm.md) |
| **UTXO** (Bitcoin, Litecoin, Dogecoin + testnets) | [utxo/](../utxo) | `UtxoChain` + `BtcChain` over `bitcoinjs-lib` v7 + `coininfo` — see [utxo.md](./utxo.md) |
| **Solana** (mainnet, devnet, testnet) | [solana/](../solana) | `SolanaChain` over `@solana/web3.js` v1 + SPL Token / Token-2022 — see [solana.md](./solana.md) |
| **TON** | [ton/](../ton) | `TonAddress` only (no full chain yet) |

## Quickstart

### Construct a chain instance

```ts
import { arbitrumChain } from 'omnichain';

const arb = arbitrumChain('https://arb1.arbitrum.io/rpc');
await arb.getBalance('0xabc…', /* tokenIdentifier */ 'NATIVE');
```

For BTC:

```ts
import {
  bitcoinMainnetChain,
  BitcoinCoreTool,
  BITCOIN_MAINNET_PARAMS,
} from 'omnichain';

const core = new BitcoinCoreTool({
  baseUrl: 'http://localhost:8332',
  user: 'user',
  password: 'pass',
  params: BITCOIN_MAINNET_PARAMS,
  wallet: 'pluton-hot-wallet',
});

const btc = bitcoinMainnetChain({
  chainId: -1,
  utxoProvider: core,
  rawTxProvider: core,
  feeEstimator: core,
  broadcaster: core,
  chainTipProvider: core,
});
```

For Solana:

```ts
import { SolanaMainnet, Priority } from 'omnichain';

const cuMicroLamports = await SolanaMainnet.suggestPriorityFeeMicroLamports(Priority.NORMAL);
const balance = await SolanaMainnet.getBalance('5gUu…');
```

### Network-aware fee suggestion (Priority)

Each chain owns its own fee-suggestion math; the consumer just passes a
`Priority` and signs whatever envelope is returned.

| Chain | Method | Result | RPC call under the hood |
|---|---|---|---|
| EVM | `chain.suggestGas(priority)` | `EvmGasEstimate { maxFeePerGas, maxPriorityFeePerGas }` | `eth_feeHistory` percentiles `{SLOW:p25, NORMAL:p50, FAST:p90}` + 0.05 gwei floor; falls back to `getFeeData × multiplier` |
| BTC / UTXO | `chain.suggestFeeRate(priority)` | `number` (sats/vByte) | `feeEstimator.getFeeEstimate(targetBlocks)` with `FAST:1, NORMAL:3, SLOW:6` |
| Solana | `chain.suggestPriorityFeeMicroLamports(priority)` | `number` (microlamports/CU) | `getRecentPrioritizationFees({ lockedWritableAccounts: [] })` percentiles `{SLOW:p25, NORMAL:p50, FAST:p90}`; `0` on a quiet cluster |

### Build a transfer

The unified entry point is `Chain.createTransferUnsignedTransaction(req)`,
where `req` is the same shape for every chain:

```ts
const unsigned = await chain.createTransferUnsignedTransaction({
  from: senderAddress,
  to: recipientAddress,
  tokenIdentifier: 'NATIVE',            // or an ERC-20 / SPL / etc. identifier
  amount: 1_000_000n,                   // smallest unit (wei / sats / lamports)
  memo: 'optional UTF-8 memo',          // BTC: emits OP_RETURN; EVM: ignored
});
```

The returned object is a chain-specific subclass of `UnsignedTransaction`:

- EVM → `UnsignedEvmTransaction` (`{ to, value, data, chainId }`)
- UTXO → `UnsignedUtxoTransaction` (`{ psbtBase64, selectedInputs, feeSats, inputsToSign, … }`)
- Solana → `UnsignedSolanaTransaction` (`{ transaction: VersionedTransaction, … }`)

Signers (wallets, hardware devices, the protocol itself) take this and
sign it externally; the chain module **does not hold keys** and **does not
read environment variables** for credentials.

### Check transaction status

```ts
const status = await chain.getTransactionStatus(txHash);
// { status: 'Success' | 'Failed' | 'Pending' | 'NotFound',
//   confirmations, balanceChanges[], gasFee | null, errorInfo? }
```

## Error model

All errors thrown by this module are `ChainError` with a typed
`kind` field — see [errors.ts](../errors.ts):

- `NotSupported`, `RpcError`, `RpcChainIdMismatch`, `TransactionDecodeFailed`,
  `InvalidAddress`, `InvalidTokenIdentifier`, `RpcNotConfigured`

Use `isChainError(err, ChainErrorKinds.InvalidAddress)` to narrow.

## NetworkType registry

Some addresses look identical across networks (e.g. all `0x…` 20-byte hex
addresses are valid EVM-shaped, but a real EVM-vs-non-EVM dispatch needs
context). The module maintains a small registry mapping `chainId →
NetworkType`. EVM is the default; non-EVM chains register themselves
when constructed:

- `EvmChain` doesn't register (EVM is the fall-through default)
- `UtxoChain` constructor calls `registerNonEvmChain(Number(chainId), NetworkType.BTC)`
- `SolanaChain` constructor calls `registerNonEvmChain(Number(chainId), NetworkType.SOLANA)`
- `TonAddress` users register their chain IDs manually if needed

`addressFor(chainId, raw)` reads from this registry to pick the right
`Address` subclass.

## Chain IDs

- **EVM chains** use real EVM `chainId` values (1, 42161, 8453, 56, …).
- **Non-EVM chains** (BTC/LTC/DOGE/TON/SOL) have no universal numeric ID.
  The caller picks one and passes it to the factory. The chain module does
  not ship a specific scheme — that's a service-level decision (see each
  consumer's `networks.service.ts` / config files).
- The seeded Solana chains use synthetic negative IDs to fit the same
  `Map<number, Chain>` storage shape consumers use for EVM.

## Boundary: this module never reads env

Constructors take plain config objects (`baseUrl`, `user`, `password`,
`rpcUrl`, …). Consumers read env / yaml once at boot and pass the
resolved values in. Adding `process.env` or any `getConfigValue` import
anywhere under this SDK is a review-blocker.

## Adding a new chain

### New EVM chain
Add a factory function to [evm/evm_chains.ts](../evm/evm_chains.ts):

```ts
export const POLYGON_CHAIN_ID = 137;
export const Polygon = new EvmChain({
  chainId: POLYGON_CHAIN_ID,
  name: 'Polygon',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://polygonscan.com',
  nativeSymbol: 'MATIC',
  // rpcUrl is optional. When omitted, the SDK resolves via env-var fallback:
  //   POLYGON_RPC_URL, then EVM_137_RPC_URL, then throws RpcNotConfigured.
});
```

The RPC URL precedence for every `EvmChain` is:

1. `rpcUrl` passed at construction (wins).
2. `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL` env var (e.g. `POLYGON_RPC_URL`).
3. `EVM_<chainId>_RPC_URL` env var.
4. Throws `ChainError(RpcNotConfigured)` on first RPC call.

Solana is similar but has a required `defaultRpcUrl` that acts as the final
fallback instead of throwing — see [solana.md](./solana.md).

### New UTXO chain
See [utxo.md](./utxo.md) — define `UtxoNetworkParams` (use `coininfo` for
network bytes), write a factory under the appropriate subdirectory.

### New chain family entirely (Cosmos, Aptos, etc.)
Add `Foo` enum value to [network_type.ts](../network_type.ts), create
`foo/` with `FooChain extends Chain`, `FooAddress extends Address`,
`UnsignedFooTransaction extends UnsignedTransaction`. Wire into
[address.factory.ts](../address.factory.ts).

## Testing layout

| Spec | What it verifies |
|---|---|
| [test/](../test) | Address factory + registry + cross-chain glue |
| [evm/test/](../evm/test) | EVM address parsing + EVM chain RPC mocks + `suggestGas` percentile / fallback / legacy paths |
| [solana/test/](../solana/test) | Solana address validators + `suggestPriorityFeeMicroLamports` percentile / empty-cluster |
| [utxo/btc/test/](../utxo/btc/test) | BTC parsing, fee math, coin selection, chain transfer round-trip with mocked providers + `suggestFeeRate` targetBlocks mapping |
| `<consumer>/test/integration/` | Live-network smoke checks belong in the consuming service, not this SDK |

## See also

- [evm.md](./evm.md) — EVM chains and ERC-20
- [utxo.md](./utxo.md) — Bitcoin / Litecoin / Dogecoin, fee estimation, asset filtering
- [solana.md](./solana.md) — Solana, SPL Token, Token-2022, priority-fee model
