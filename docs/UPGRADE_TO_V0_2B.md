# Upgrade to Phase 2B (`sinan-py-parity-2b` branch)

Additive on top of Wave 2A. Two structural additions match Python's
public contract:

- `AssetBalanceChange.balanceChangeHr: Decimal` lazy accessor +
  `fromHr(hr, decimals)` factory
- `CreateTransferRequest` accepts `amountHr: Decimal` /
  `isFullBalance: boolean` / `gasPricing: FeePriority | AbstractGasPricing`
  alongside the existing `amount: bigint`

## New dependency

Add **`decimal.js`** to your `package.json`:

```
npm install decimal.js
```

Wave 2A shipped `AssetBalanceChange` as bigint-only precisely so this
install could be coordinated with 2B — no phase ships a half-installed
peer dep.

## New: `AssetBalanceChange.balanceChangeHr` + `fromHr`

```ts
import { AssetBalanceChange } from 'omnichain';
import Decimal from 'decimal.js';

// Read-side: bigint is still the source of truth (avoids decimal.js's
// 20-sig-digit default truncating 18-decimal amounts ≥ ~100 tokens).
// balanceChangeHr is derived on read.
const c = AssetBalanceChange.fromMr(1_500_000_000_000_000_000n, 18);
c.balanceChangeMr;             // 1500000000000000000n
c.balanceChangeHr.toFixed();   // "1.5"

// Write-side factory: mirrors Python's balance_change_hr constructor.
// Rounds via Decimal.trunc() matching hr_to_mr.
const d = AssetBalanceChange.fromHr(new Decimal('1.5'), 18);
d.balanceChangeMr;             // 1500000000000000000n

// toString() uses toFixed() to avoid scientific notation on ≥ 21-digit
// amounts (decimal.js toExpPos default).
c.toString();                  // "[change:1.5]"
```

Python parity: `balance_change_hr: Decimal` matches
`AbstractAssetBalanceChange` at `base/base.py:239-247`.

## Changed: `CreateTransferRequest` — Python-parity amount + gas contract

New optional fields on `CreateTransferRequest`:

| Field | Type | Python name | Notes |
|---|---|---|---|
| `amount` | `bigint` | (TS-native) | Minor units. Original form, still supported. |
| `amountHr` | `Decimal` | `amount_hr` | Human-readable. Chain builder converts via token decimals. |
| `isFullBalance` | `boolean` | `is_full_balance` | Sweep sender's full balance. Requires `from`. |
| `gasPricing` | `FeePriority \| AbstractGasPricing` | `gas_pricing` | Defaults to `FeePriority.NORMAL`. |
| `memo` | `string` | (unchanged) | Optional; supported on chains that carry data blobs. |

**Contract:** exactly one of `{amount, amountHr, isFullBalance}` must be
supplied. Ambiguous input (two or more set) throws
`ChainError(InvalidArgument)`. Enforced by `resolveTransferAmount`
exported from `chain.base.ts`.

```ts
// BEFORE (Wave 2A)
await chain.createTransferUnsignedTransaction({
  from: sender,
  to: recipient,
  tokenIdentifier: usdcAddress,
  amount: 1_500_000n,   // 1.5 USDC in minor units
});

// AFTER (Wave 2B) — human-readable amount
await chain.createTransferUnsignedTransaction({
  from: sender,
  to: recipient,
  tokenIdentifier: usdcAddress,
  amountHr: new Decimal('1.5'),
  gasPricing: FeePriority.FAST,   // or new EvmGasPricing({ kind: 'eip1559', … })
});

// AFTER (Wave 2B) — sweep full balance
await chain.createTransferUnsignedTransaction({
  from: sender,
  to: recipient,
  isFullBalance: true,
});
```

## New: `FeePriority` alias for `Priority`

Python uses `FeePriority` (`base/base.py:123`); TS keeps `Priority` as
the canonical name. Both work:

```ts
import { Priority, FeePriority } from 'omnichain';

Priority.SLOW === FeePriority.SLOW; // true
```

## New: `AbstractGasPricing` + per-chain subclasses

Explicit numeric fee overrides — mirrors Python's `AbstractGasPricing`
+ `EvmGasPricing` / `SolanaGasPricing` / `UtxoGasPricing`.

```ts
import { EvmGasPricing } from 'omnichain';

await arbitrumChain.createTransferUnsignedTransaction({
  from: sender,
  to: recipient,
  amountHr: new Decimal('0.05'),
  gasPricing: new EvmGasPricing({
    kind: 'eip1559',
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }),
});
```

`EvmGasPricing` is discriminated by `kind: 'legacy' | 'eip1559'` for the
same reason `EvmGasEstimate` is — consumers can't accidentally read a
1559 field on a legacy pricing.

`SolanaGasPricing`: `priorityFeeMicroLamports: bigint` +
optional `computeUnitLimit: bigint`.

`UtxoGasPricing`: `satsPerVByte: number`.

## New: `EvmParsedTransactionLog.isTransferLog / asTransferLog`

Deferred from Wave 2A card §3b. Both methods now implemented; the
`evm_chain.ts` decoder consumes them via the shared
`ERC20_TRANSFER_TOPIC` constant so there's exactly one parser.

```ts
import { EvmParsedTransactionLog, EvmErc20TransferLog, isSuccess } from 'omnichain';

const status = await arbitrumChain.getTransactionStatus(txHash);
if (isSuccess(status)) {
  const transfers: EvmErc20TransferLog[] = status.logs
    ?.filter((l) => l.isTransferLog())
    .map((l) => l.asTransferLog()) ?? [];
}
```

Addresses in `EvmErc20TransferLog` are lowercased (matches the
`balanceChanges` wallet-key convention). Consumers who need EIP-55
checksums should pass through `EvmAddress`.

## Not yet wired

- **UTXO `createTransferUnsignedTransaction`** doesn't consume
  `amountHr` / `isFullBalance` / `gasPricing` in Wave 2B — the multi-
  recipient `outputs[]` form has its own semantics. Deferred to a
  follow-up UTXO card. `CreateUtxoTransferOptions` still accepts the
  base fields (TS won't reject them) but they're ignored.
- **Solana + EVM `createTransferUnsignedTransaction`** consume
  `amount` / `amountHr` / `isFullBalance` but do NOT yet consume
  `gasPricing` — existing per-chain option fields
  (`priorityFeeMicroLamportsPerCu`, `computeUnitLimit` on Solana; ethers
  tx builder options on EVM) still work. Full `gasPricing` handling per-
  chain is a Phase 2 follow-up.

## Grep targets for consumer teams

- `\.amount:` on `CreateTransferRequest` construction sites — still
  works, but consider switching to `.amountHr` for readability.
- `\.balanceChangeHr` — new accessor, safe to consume.
- `import.*Priority` — `FeePriority` alias available if you prefer the
  Python name.

## Verification checklist

- [ ] `npm install decimal.js` in the consumer
- [ ] Consumer builds pass with the new optional `CreateTransferRequest`
      fields (they're all optional; the existing `amount: bigint` form
      still compiles)
- [ ] Tests importing `Decimal` from `decimal.js` resolve
- [ ] Full jest suite still green
