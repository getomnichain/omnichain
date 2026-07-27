# Upgrade to Phase 2A (`sinan-py-parity-2a` branch)

This branch is **breaking** — three structural refactors and zero new
runtime dependencies. Merge order after Phase 1 (`sinan-py-parity`) has
been shipped.

## Wave 2A amount representation

`AssetBalanceChange` stores balance deltas as **`bigint` minor units only**
(`balanceChangeMr`). The Python-parity `balance_change_hr: Decimal`
accessor is deliberately deferred to **Wave 2B** — it needs `decimal.js`
as a peer dep, which requires a coordinated `npm install` in every
consumer, and that coordination happens with Wave 2B's `FeePriority`
threading. Until then, consumers who need a human-readable form compute
it themselves from `balanceChangeMr` and `decimals`.

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
import { isSuccess, EvmTransactionStatus } from 'omnichain';
const status = await chain.getTransactionStatus(txHash);  // EvmTransactionStatus | SolanaTransactionStatus | UtxoTransactionStatus
if (isSuccess(status)) {
  for (const [wallet, perAsset] of status.balanceChanges) {
    for (const { token, change } of perAsset.values()) {
      // Wave 2A ships bigint minor units only. balanceChangeHr (Decimal)
      // returns in Wave 2B alongside decimal.js.
      console.log(wallet, token.symbol, change.balanceChangeMr);
    }
  }
}
if (status instanceof EvmTransactionStatus) {
  console.log(status.fees?.totalGasInWei);
}
```

**Grep targets for consumer teams:**
- `\.balanceChanges\.map\(|\.balanceChanges\.filter\(|\.balanceChanges\[|for.*of.*\.balanceChanges` — was iterating an array; is now iterating a `Map<wallet, Map<assetHash, {token, change}>>`
- `\.gasFee\b` — replaced by `status.fees` on `EvmTransactionStatus`/`SolanaTransactionStatus`/`UtxoTransactionStatus` (each subclass has its own fees value type)
- `\.errorInfo\b` — renamed to `\.error`
- `\.txTimestamp\b` — renamed to `\.inclusionAt`
- `\.blockNumber\b` — dropped from the shape (Python parity — Python doesn't surface it on `EvmTransactionStatus`). Query provider directly if you need it.
- `\.confirmations\b` — dropped on EVM/Solana. Still present on `UtxoTransactionStatus`.
- `\.decodeBalanceChanges\(` (EVM) — signature changed: now takes a required `gasCost: bigint` and returns `NestedBalanceChanges` instead of `BalanceChange[]`.

**Known accounting gap (Python parity):** `Failed` status has
`balanceChanges: null` — the actual gas/fee that was burned by a
reverted tx (EVM `gasUsed × effectiveGasPrice`, Solana `feeLamports`)
is NOT surfaced through `balanceChanges` and must be reconstructed by
the consumer from `status.fees` when reconciling debits. This mirrors
`omnichain-py`'s `AbstractTransactionStatus` invariant (Failed →
`balance_changes is None`); TS honors it verbatim.

## New: `AssetBalanceChange` + `NestedBalanceChanges`

Value type (Wave 2A shape — bigint only):
```ts
class AssetBalanceChange {
  balanceChangeMr: bigint;    // minor units (Python: balance_change_mr)
  decimals: number;

  static zero(decimals?: number): AssetBalanceChange;
  static fromMr(mr: bigint, decimals: number): AssetBalanceChange;
  add(other: AssetBalanceChange): AssetBalanceChange;         // uses this.decimals (Python __add__ parity)
  static upsert(container, wallet, token, change): void;      // mutating (Python parity)
}
```

Container:
```ts
type NestedBalanceChanges = Map<
  string,                                                   // wallet address
  Map<string, { token: Token; change: AssetBalanceChange }> // assetHashOf(token) → entry
>;
```

`assetHashOf(token) = ${chainId}_${identifier ?? ''}` — keys on the
stable `Token.sameAsset` identity. `symbol` is intentionally excluded
because it comes from a live `contract.symbol()` on EVM and falls back
to `UNKNOWN_<hex>` on RPC failure — keying on it would produce different
keys for the same asset across transient RPC health. `decimals` is
excluded because Solana `uiTokenAmount.decimals` variance would
otherwise split one asset into two non-cancelling rows. Both fields are
preserved on the stored entry's `token` for display.

Deviation from Python's `AbstractAsset.__hash__` (which is
`chainId_symbol_identifier_decimals`) — Python's hash and eq disagree
(`__eq__` excludes decimals but `__hash__` includes them, a known
upstream wart). TS keys on the `__eq__` identity to keep dict lookups
consistent. See `SINAN_OPEN_QUESTIONS.md`.

**`upsert` semantics (Python `base/base.py:255-287` parity):**
- Mutating; returns `void`
- On zero-net merge (existing + change == 0): deletes the asset row AND
  the wallet row if the wallet's inner map becomes empty
- On non-zero-net merge: replaces the entry with a new
  `AssetBalanceChange` using `change.decimals` (the newer change wins on
  decimals, not the existing entry's)
- No decimals-mismatch throw — Python doesn't check either

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

Constructor accepts `>= 0` for all fee fields (matches
`EvmTransactionGasFees` — subsidised chains and devnets report zero
prices; throwing there would turn a read-only estimate into an
exception). Only strictly-negative values throw.

## Changed: `UtxoChain` reserved-BTC-chainId guard

Constructing a UTXO chain at a reserved BTC chainId
(`CHAIN_ID_BITCOIN_MAINNET/TESTNET/SIGNET` = `-1/-2/-3`) now requires
the incoming `params` to be shape-identical to the seeded BTC params
for that id. Anything else — LTC/DOGE mainnet or testnet, an
alternate-`walletAddressRegex` fork — throws
`ChainError(InvalidArgument)`. Pick a distinct chainId for those.
Uses the exact same comparator that `registerBtcChainParams` uses, so
both guards enforce one invariant.

**Grep target:** search for `new UtxoChain\(` or `chainId: -1|-2|-3\b` with
non-BTC `params`.

## Changed: `registerBtcChainParams` — reserved-seed idempotent + shape-equal conflict check

- The three seeded chainIds (`-1`, `-2`, `-3`) are **reserved**:
  re-registration is accepted iff the incoming params are shape-
  identical to the seed (this is what `BtcChain`'s constructor does
  every time it constructs). Anything else throws
  `ChainError(InvalidArgument)`. Pick a distinct chainId for custom
  BTC-shaped params.
- Non-seeded conflict check compares all identity-relevant fields
  (`name`, `hrp`, `slip44CoinId`, `walletAddressRegex.source`+`flags`,
  `dustValueSats`, `pubKeyHash`, `scriptHash`, `bip32 pub/priv`, plus
  the contents of `supportedDerivationPurposes`). Silent-replace-with-
  different-grammar is not possible on any registered id.
- New `unregisterBtcChainParams(chainId)` — silent no-op on the three
  reserved ids (so a consumer teardown helper works uniformly for any
  id), deletes a consumer-registered entry otherwise.
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

- [ ] All `.balanceChanges` reads updated to `Map<wallet, Map<assetHash, entry>>`
- [ ] All `.gasFee` reads updated to `status.fees` (typed per subclass)
- [ ] All `.errorInfo` reads renamed to `.error`
- [ ] All `.txTimestamp` reads renamed to `.inclusionAt`
- [ ] `.blockNumber` and `.confirmations` reads on EVM/Solana either removed or moved to a provider query
- [ ] `.verifyMessageSignature(…)` calls migrated to the ethers / node-crypto / bitcoinjs-message shims above
- [ ] `chain.supportsEip1559`-based fee dispatch replaced with `isLegacyGasEstimate` / `isEip1559GasEstimate`
- [ ] `nest build` / `tsc --noEmit` clean
- [ ] Full jest suite green
