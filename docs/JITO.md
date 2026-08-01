# Solana Jito bundles

Opt-in per chain: pass `jito: { url, auth? }` to the `SolanaChain` constructor. Methods below throw `ChainError(FeatureNotSupported)` when `chain.jito === null`.

## Single-tx via broadcast

```ts
import { SolanaChain } from '@getomnichain/omnichain';

const chain = new SolanaChain({
  ...init,
  jito: { url: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles' },
});

const bundleId = await chain.broadcast(signedBytes, { via: 'jito' });
const status = await chain.getBundleStatus(bundleId);
```

## Multi-tx bundle

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
