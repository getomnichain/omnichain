# Solana Jito bundles

Opt-in per chain: pass `jito: { url, auth? }` to the `SolanaChain` constructor. Methods below throw `ChainError(FeatureNotSupported)` when `chain.jito === null`.

## Single-tx via broadcast

```ts
import { SolanaChain } from '@getomnichain/omnichain';

const chain = new SolanaChain({
  ...init,
  jito: { url: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles' },
});

// Broadcast a single signed tx as a 1-tx Jito bundle.
// Returns the base58-encoded transaction signature (NOT the bundle id).
const sig = await chain.broadcast(signedBytes, { via: 'jito' });
const status = await chain.getTransactionStatus(sig, { wait: true });
```

`broadcast({ via: 'jito' })` submits the transaction as a 1-tx bundle and returns the tx **signature** (the base58 of the first 64 bytes of the serialized transaction). The signature is the same value `chain.getTransactionStatus` accepts — the two APIs are consistent. The corresponding bundle id is a wire-level detail owned by the SDK and not surfaced through this path.

## Multi-tx bundle

For a real multi-tx bundle the bundle id is meaningful. Use `submitJitoBundle` explicitly:

```ts
const bundleId = await chain.submitJitoBundle([signedTx1, signedTx2, signedTx3]);
const status = await chain.getBundleStatus(bundleId);
// { bundleId, state: 'Pending' | 'Landed' | 'Failed', slot?, err? }
```

`getBundleStatus` accepts a single id OR an array (batch polling):

```ts
const [a, b, c] = await chain.getBundleStatus(['id1', 'id2', 'id3']);
```

## Simulating a bundle

`simulateBundle` runs 1 to 5 transactions in order on the chain's **RPC URL** (not the block engine, and no `jito` config needed). Each transaction sees the state the earlier ones left, so a transaction can be sized against funds an earlier one provides:

```ts
const result = await chain.simulateBundle([fundUserTx, siteTx], {
  postAccounts: [null, [user]],   // accounts to read after each transaction, or null
  sigVerify: false,               // default: signatures are not checked, so unsigned bytes work
  replaceRecentBlockhash: false,  // default: keep each transaction's blockhash
});

if (result.succeeded) {
  const userLamports = result.transactions[1].postAccounts[0]?.lamports;
} else {
  result.failedIndex;   // the transaction that failed
  result.error;         // e.g. "Blockhash not found"
}
```

- Each transaction must be 65 to 1232 bytes and a serialized `VersionedTransaction`; `postAccounts` has one entry per transaction. Anything else throws `InvalidArgument` (`InvalidAddress` for a bad address) before any request.
- Every result has `err`, `logs`, `unitsConsumed`, `fee` and the requested `postAccounts` as `{ lamports, data }`, in the order asked. An account that does not exist reads as 0 lamports and no data.
- A failed simulation is returned, not thrown. Results stop at the failing transaction, so later ones have none.
- An RPC that does not serve the method throws `FeatureNotSupported`: JSON-RPC `-32601` (Ankr) or HTTP 410 (`api.mainnet-beta.solana.com`). publicnode, Helius and Alchemy serve it. `SolanaChain` holds one RPC URL, so trying another endpoint is the caller's choice. Any other failure throws `RpcError`, with keyed URLs redacted.
- `npm run test:live:solana` checks all of this on mainnet, read-only (see `.env.solana.example`).

## Bundle composition + tip strategy

Consumer-owned. The SDK exposes wire-level submit + status only. Tip instructions (e.g. `SystemProgram.transfer` to a Jito tip account) must be composed into the transactions before signing.
