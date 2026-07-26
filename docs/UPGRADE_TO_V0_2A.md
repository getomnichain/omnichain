# Upgrade to Phase 2A (`sinan-py-parity-2a` branch)

This branch is **breaking** — three structural refactors and one dependency
addition. Merge order after Phase 1 (`sinan-py-parity`) has been shipped.

## New dependency

Add **`decimal.js`** to your `package.json`:

```
npm install decimal.js
```

`AssetBalanceChange` now stores its human-readable amount as `Decimal`
(Python parity — Python's `AbstractAssetBalanceChange.balance_change_hr`
is `decimal.Decimal`). The `bigint` minor-unit representation is still
available on `.balanceChangeMr`.

## Removed: `verifyMessageSignature`

The abstract `verifyMessageSignature(req)` on `Chain` and its three
implementations (EVM / Solana / BTC) are gone.
`grep verify_message_signature omnichain-py/` returns zero matches — the
TS extension had no Python counterpart.

**Consumer migration** — use each ecosystem's library directly:

**EVM (ethers v6):**
```ts
import { verifyMessage as ethersVerifyMessage, getAddress } from 'ethers';
const recovered = ethersVerifyMessage(message, signature);
const isValid = recovered === getAddress(signerAddress);
```

**Solana (@solana/web3.js + node crypto):**
```ts
import { createPublicKey, verify as nodeVerify } from 'node:crypto';
import bs58 from 'bs58';
const rawSigner = bs58.decode(signerAddress);
if (rawSigner.length !== 32) return false;
const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const signerKey = createPublicKey({
  key: Buffer.concat([spkiPrefix, Buffer.from(rawSigner)]),
  format: 'der',
  type: 'spki',
});
const sigBytes = bs58.decode(signature);
if (sigBytes.length !== 64) return false;
const isValid = nodeVerify(null, Buffer.from(message, 'utf8'), signerKey, sigBytes);
```

**BTC (bitcoinjs-message):**
```ts
import * as bitcoinMessage from 'bitcoinjs-message';
const isValid = bitcoinMessage.verify(
  message, signerAddress, signature,
  chain.params.networkInfo.messagePrefix, true,
);
```

## New: `TransactionStatus` hierarchy — per-network subclasses

The old flat interface is gone. The new shape mirrors Python's
`AbstractTransactionStatus` + `EvmTransactionStatus` / `SolanaTransactionStatus` /
`UtxoTransactionStatus`.

**Base fields (on every subclass):**
- `chainId: number`
- `status: TransactionStatusType`  (`'Success' | 'Failed' | 'Pending' | 'NotFound'`)
- `inclusionAt: Date | null`
- `error: TransactionErrorInfo | null`
- `balanceChanges: NestedBalanceChanges | null`  (see next section)

**Subclass-specific fields:**
- `EvmTransactionStatus`: `logs`, `fees` (see `EvmTransactionGasFees`)
- `SolanaTransactionStatus`: `fees` (see `SolanaTransactionFees`)
- `UtxoTransactionStatus`: `inputs`, `outputs`, `vsize`, `confirmations`

**Runtime asserts (enforced in the constructor):**

| status_type | balanceChanges | error |
|---|---|---|
| Success  | required (non-null) | must be null |
| Failed   | must be null | required |
| Pending  | must be null | must be null |
| NotFound | must be null | optional |

Assertion violations throw `ChainError(InvalidArgument)`.

**Consumer migration** — replace flat-status reads:

```ts
// BEFORE (Phase 1)
const status = await chain.getTransactionStatus(txHash);
if (status.status === 'Success') {
  for (const bc of status.balanceChanges) {
    console.log(bc.address, bc.token.symbol, bc.amount);
  }
  console.log(status.gasFee?.amount);
}

// AFTER (Phase 2A)
import { isSuccess } from 'omnichain';
const status = await chain.getTransactionStatus(txHash);  // EvmTransactionStatus | SolanaTransactionStatus | UtxoTransactionStatus
if (isSuccess(status)) {
  for (const [wallet, perAsset] of status.balanceChanges) {
    for (const { token, change } of perAsset.values()) {
      console.log(wallet, token.symbol, change.balanceChangeMr, change.balanceChangeHr.toString());
    }
  }
}
if (status instanceof EvmTransactionStatus) {
  console.log(status.fees?.totalGasInWei);
}
```

**Grep targets for consumer teams:**
- `\.balanceChanges\.map\(|\.balanceChanges\.filter\(|\.balanceChanges\[|for.*of.*\.balanceChanges` — was iterating an array; is now iterating a `Map<wallet, Map<assetHash, {token, change}>>`
- `\.gasFee\b` — replaced by `status.fees` (typed by subclass)
- `\.errorInfo\b` — renamed to `\.error`
- `\.txTimestamp\b` — renamed to `\.inclusionAt`
- `\.blockNumber\b` — dropped from the shape (Python parity — Python doesn't surface it on `EvmTransactionStatus`). Query provider directly if you need it.
- `\.confirmations\b` — dropped on EVM/Solana. Still present on `UtxoTransactionStatus`.

## New: `AssetBalanceChange` + `NestedBalanceChanges`

Value type:
```ts
class AssetBalanceChange {
  balanceChangeHr: Decimal;   // human-readable (Python: balance_change_hr)
  balanceChangeMr: bigint;    // minor units (Python: balance_change_mr)
  decimals: number;

  static zero(decimals?: number): AssetBalanceChange;
  static fromMr(mr: bigint, decimals: number): AssetBalanceChange;
  add(other: AssetBalanceChange): AssetBalanceChange;
  static upsert(container, wallet, token, change): void;  // Python parity, mutating
}
```

Container:
```ts
type NestedBalanceChanges = Map<
  string,                                                   // wallet address
  Map<string, { token: Token; change: AssetBalanceChange }> // assetHashOf(token) → entry
>;
```

`assetHashOf(token) = ${chainId}_${symbol}_${identifier ?? ''}_${decimals}` —
mirrors Python's `AbstractAsset.__hash__`. Two tokens with the same
(chainId, symbol, identifier) but different `decimals` are DISTINCT keys.
This matches Python's behavior (Python's `__hash__` includes decimals, its
`__eq__` doesn't — a known upstream wart carried forward; see
`SINAN_OPEN_QUESTIONS.md`).

**`upsert` semantics (Python `base/base.py:255-287` parity):**
- Mutating; returns `void`
- On zero-net merge (existing + change == 0): deletes the asset row AND
  the wallet row if the wallet's inner map becomes empty
- On non-zero-net merge: replaces the entry with a new
  `AssetBalanceChange` using `change.decimals` (the newer change wins on
  decimals, not the existing entry's)

## Changed: `EvmGasEstimate` — discriminated by `kind`

Consumer dispatch on `chain.supportsEip1559` is no longer needed — the
estimate carries its own shape tag.

```ts
type EvmGasEstimate =
  | { kind: 'legacy';   units?: bigint; gasPrice: bigint }
  | { kind: 'eip1559';  units?: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

if (isEip1559GasEstimate(estimate)) {
  tx.maxFeePerGas = estimate.maxFeePerGas;
  tx.maxPriorityFeePerGas = estimate.maxPriorityFeePerGas;
} else if (isLegacyGasEstimate(estimate)) {
  tx.gasPrice = estimate.gasPrice;
}
```

Constructor validates positivity — sub-zero fees throw at construction
rather than surfacing as an unmineable tx.

## Changed: `UtxoChain` reserved-BTC-chainId guard

Constructing a non-BTC UTXO chain (LTC / DOGE / DASH / ZEC / BCH — any
`slip44CoinId != 0 && != 1`) with a reserved BTC chainId
(`CHAIN_ID_BITCOIN_MAINNET/TESTNET/SIGNET`) now throws
`ChainError(InvalidArgument)`. Pick a distinct chainId for your
non-BTC UTXO chain.

**Grep target:** search for `new UtxoChain\(` or `chainId: -1|-2|-3\b` with
non-BTC `params`.

## Changed: `registerBtcChainParams` — reserved-seed rejection + deep-equal conflict check

- The three seeded chainIds (`-1`, `-2`, `-3`) are now **reserved** —
  any consumer re-registration attempt throws
  `ChainError(InvalidArgument)`, even with matching-name params.
- Non-seeded conflict check now compares identity-relevant fields
  (`hrp`, `pubKeyHash`, `scriptHash`, `bip32 pub/priv`) rather than
  `name` alone. Silent-replace-with-different-grammar is not possible
  on any registered id.
- New `unregisterBtcChainParams(chainId)` — throws on reserved ids;
  deletes a consumer-registered entry otherwise.
- Pair with `unregisterChain(id)` from `network_type.ts` when tearing
  down a custom BTC-shaped id. Cross-module coupling is deliberately
  avoided — you call both.

## Changed: `registerNonEvmChain` — integer guard

Non-integer chainIds (`NaN`, `Infinity`, `1.5`, etc.) now throw
`ChainError(InvalidArgument)` at the registration call. Previously the
failure surfaced later at the first `networkTypeOf()` lookup.

## Coordination critical — depositron `-100` reminder

If not yet done, the depositron `solana-sponsor-balance-monitor.service.ts`
hardcodes Solana chainId `-100`. Phase 1's Solana-chainId migration flipped
it to `-2000`. Patch must ship with this train.

## Verification checklist

- [ ] `npm install decimal.js` in the consumer
- [ ] All `.balanceChanges` reads updated to `Map<wallet, Map<assetHash, entry>>`
- [ ] All `.gasFee` reads updated to `status.fees` (typed per subclass)
- [ ] All `.errorInfo` reads renamed to `.error`
- [ ] All `.txTimestamp` reads renamed to `.inclusionAt`
- [ ] `.blockNumber` and `.confirmations` reads on EVM/Solana either removed or moved to a provider query
- [ ] `.verifyMessageSignature(…)` calls migrated to the ethers / node-crypto / bitcoinjs-message shims above
- [ ] `chain.supportsEip1559`-based fee dispatch replaced with `isLegacyGasEstimate` / `isEip1559GasEstimate`
- [ ] `nest build` / `tsc --noEmit` clean
- [ ] Full jest suite green
