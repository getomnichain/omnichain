# @getomnichain/omnichain

Multi-chain TypeScript SDK. One `Chain` / `Token` / `Address` / `UnsignedTransaction` shape for EVM, UTXO (BTC/LTC/DOGE/DASH/ZEC/BCH), Solana, TON, and Tron. Line-for-line parity port of Python's [`omnichain-py`](https://github.com/getomnichain/omnichain-py).

```bash
npm install @getomnichain/omnichain decimal.js
```

`decimal.js` is a required peer install — the package imports it at the root and consumer builds fail at import time if it's missing.

## Quick start

```ts
import { arbitrumChain, isSuccess, Priority } from '@getomnichain/omnichain';
import Decimal from 'decimal.js';

const chain = arbitrumChain({ rpcUrl: process.env.ARBITRUM_RPC_URL });

const unsigned = await chain.createTransferUnsignedTransaction({
  from: senderAddress,
  to: recipientAddress,
  tokenIdentifier: usdcAddress,
  amountHr: new Decimal('1.5'),
});

const status = await chain.getTransactionStatus(txHash);
if (isSuccess(status)) {
  for (const [wallet, perAsset] of status.balanceChanges) {
    for (const { token, change } of perAsset.values()) {
      console.log(wallet, token.symbol, change.balanceChangeMr, change.balanceChangeHr.toFixed());
    }
  }
}

const gas = await chain.suggestGas(Priority.NORMAL);
```

Consumer TypeScript setup: `module: "NodeNext"` + `moduleResolution: "NodeNext"`. The package ships compiled `.js` + `.d.ts` under `dist/`; the source is `.ts` on GitHub for anyone who wants to read the implementation.

## What this SDK does NOT do

- **Hold keys** — signing happens in the consumer service. The SDK only emits `UnsignedTransaction` objects.
- **Read environment variables** — every constructor takes an explicit config object. The one exception is RPC URL fallback resolution (`<NAME>_RPC_URL` / `EVM_<chainId>_RPC_URL` / `SOLANA_<chainId>_RPC_URL`), documented per chain.
- **Decide chain IDs** — non-EVM chains have no universal numeric ID; consumers can seed a synthetic scheme via `registerNonEvmChain(id, family)`.
- **Ship infrastructure** — RPC URLs, indexer keys, Bitcoin Core / Esplora endpoints are consumer-owned.

## Solana raw-instruction helpers

`SolanaChain` exposes two raw-instruction builders alongside `createTransferUnsignedTransaction`, for callers that will compile the transaction downstream:

- `buildNativeTransferInstruction(from, to, lamports)` — sync; wraps `SystemProgram.transfer`.
- `buildSplTransferInstructions({from, to, mint, amount, includeCreateAta?, allowOwnerOffCurve?})` — async; returns `[createATA-idempotent?, transferChecked]`. Uses the idempotent ATA form (not probe-then-create) because the downstream compiler runs instructions blindly and a probe would race with execution. `allowOwnerOffCurve` applies to both source and destination ATA derivation for PDA-owned wallets.

`createTransferUnsignedTransaction`'s compiled-tx surface uses probe-then-create for its own end-to-end signing path.

## Documentation

- [docs/README.md](./docs/README.md) — full module guide
- [docs/evm.md](./docs/evm.md) — EVM chains and ERC-20
- [docs/utxo.md](./docs/utxo.md) — Bitcoin / Litecoin / Dogecoin, fee estimation, BTC asset filtering
- [docs/solana.md](./docs/solana.md) — Solana, SPL Token, Token-2022, priority-fee model
- [docs/PUBLISHING.md](./docs/PUBLISHING.md) — release + npm publish workflow

## License

MIT — see [LICENSE](./LICENSE).
