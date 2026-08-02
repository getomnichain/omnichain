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

## Bundle composition + tip strategy

Consumer-owned. The SDK exposes wire-level submit + status only. Tip instructions (e.g. `SystemProgram.transfer` to a Jito tip account) must be composed into the transactions before signing.
