import Decimal from 'decimal.js';

import { ChainError, ChainErrorKinds } from './errors.ts';
import { Token } from './token.ts';

/**
 * Exact `Decimal → bigint minor-units` conversion. Uses `toFixed(decimals,
 * ROUND_DOWN)` — this path is NOT bounded by `Decimal.precision` — plus
 * a string shift, so `new Decimal('123.456789012345678901')` with
 * `decimals=18` yields exactly `123456789012345678901n` instead of the
 * `.mul(1e18).trunc()` path's rounded-then-truncated `123456789012345678900n`.
 * Verified against decimal.js 10.6.0.
 */
export function hrDecimalToMinorUnits(hr: Decimal, decimals: number): bigint {
  // toFixed always emits a plain decimal representation (never scientific).
  // ROUND_DOWN = 1 truncates toward zero, matching Python's `hr_to_mr`.
  const fixed = hr.toFixed(decimals, Decimal.ROUND_DOWN);
  const negative = fixed.startsWith('-');
  const unsigned = negative ? fixed.slice(1) : fixed;
  const dot = unsigned.indexOf('.');
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? '' : unsigned.slice(dot + 1);
  const padded = fracPart.padEnd(decimals, '0').slice(0, decimals);
  const digits = (intPart + padded).replace(/^0+(?=\d)/, '') || '0';
  const mag = BigInt(digits);
  return negative ? -mag : mag;
}

/**
 * Exact `bigint minor-units → decimal-string` for human-readable display.
 * Bypasses `Decimal.div` (also precision-bounded at 20), so
 * `AssetBalanceChange.fromMr(123_456_789_012_345_678_901n, 18)` renders
 * as `"123.456789012345678901"` — no wei lost.
 */
export function minorUnitsToHrString(mr: bigint, decimals: number): string {
  const negative = mr < 0n;
  const digits = (negative ? -mr : mr).toString();
  if (decimals === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, '');
  const s = fracPart.length === 0 ? intPart : `${intPart}.${fracPart}`;
  return negative ? `-${s}` : s;
}

export const TransactionStatusTypes = {
  Success: 'Success',
  Failed: 'Failed',
  Pending: 'Pending',
  NotFound: 'NotFound',
} as const;

export type TransactionStatusType =
  (typeof TransactionStatusTypes)[keyof typeof TransactionStatusTypes];

/**
 * Stable identity key for a token in `NestedBalanceChanges`. Uses
 * `(chainId, identifier)` — matches `Token.sameAsset` identity. `symbol`
 * comes from a live `contract.symbol()` on EVM and falls back to
 * `UNKNOWN_<hex>` on RPC failure, so keying on it produces different keys
 * for the same asset across transient RPC health. `decimals` is likewise
 * omitted (already dropped in iter 1) — Solana `uiTokenAmount.decimals`
 * variance would otherwise split one asset into two non-cancelling rows.
 * `symbol`/`decimals` are preserved on the stored entry's `token` for display.
 */
export function assetHashOf(token: Token): string {
  return `${token.chainId}_${token.identifier ?? ''}`;
}

export interface AssetBalanceChangeEntry {
  token: Token;
  change: AssetBalanceChange;
}

export type NestedBalanceChanges = Map<string, Map<string, AssetBalanceChangeEntry>>;

/**
 * Per-(wallet, asset) balance delta. Source of truth is `balanceChangeMr`
 * (bigint minor units) — exact and native to every on-chain representation.
 *
 * Wave 2B adds the Python-parity `balanceChangeHr: Decimal` accessor as a
 * lazy getter derived from `mr / 10^decimals`. Storage flip vs Python
 * (which stores `balance_change_hr: Decimal` and computes `mr` in the
 * constructor): decimal.js defaults to 20 significant digits, so
 * 18-decimal amounts ≥ ~100 tokens silently truncate on Decimal → bigint
 * round-trip. Storing bigint keeps every wei/lamport/satoshi exact; the
 * Decimal getter inherits decimal.js precision limits but never influences
 * `.balanceChangeMr` on read.
 */
export class AssetBalanceChange {
  readonly balanceChangeMr: bigint;
  readonly decimals: number;

  constructor(balanceChangeMr: bigint, decimals: number) {
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `AssetBalanceChange decimals must be a non-negative integer, got ${decimals}`,
      );
    }
    this.balanceChangeMr = balanceChangeMr;
    this.decimals = decimals;
  }

  static zero(decimals: number = 0): AssetBalanceChange {
    return new AssetBalanceChange(0n, decimals);
  }

  static fromMr(balanceChangeMr: bigint, decimals: number): AssetBalanceChange {
    return new AssetBalanceChange(balanceChangeMr, decimals);
  }

  /**
   * Python-parity factory (`AssetBalanceChange.__init__` in
   * `base/base.py:239-247` takes `balance_change_hr: Decimal`). Accepts a
   * `Decimal` directly or any string/number that `new Decimal(...)`
   * parses. Rounds sub-minor-unit fractional bits DOWN matching Python's
   * `hr_to_mr`. Uses the exact string-shift path (`toFixed(decimals,
   * ROUND_DOWN)` + digit concat) rather than `.mul(10^d).trunc()` — the
   * `.mul` route is precision-bounded by decimal.js's 20-sig-digit
   * default and would round the last wei on 18-decimal amounts ≥
   * ~100 tokens.
   */
  static fromHr(
    balanceChangeHr: Decimal | string | number,
    decimals: number,
  ): AssetBalanceChange {
    // Nested-copy-safe: for Decimal-shaped objects use string round-trip
    // via toString() (exact and always reparseable), not `instanceof`
    // which fails on a Decimal from a duplicated decimal.js copy in
    // the consumer tree. Strings and numbers go straight through
    // decimal.js's own constructor.
    let hr: Decimal;
    try {
      if (
        typeof balanceChangeHr === 'object' &&
        balanceChangeHr !== null &&
        typeof (balanceChangeHr as { toFixed?: unknown }).toFixed === 'function' &&
        typeof (balanceChangeHr as { toString?: unknown }).toString === 'function'
      ) {
        hr = new Decimal((balanceChangeHr as { toString: () => string }).toString());
      } else {
        hr = new Decimal(balanceChangeHr as string | number);
      }
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `AssetBalanceChange.fromHr: unparseable input ${String(balanceChangeHr)}`,
        undefined,
        err instanceof Error ? err : undefined,
      );
    }
    if (!hr.isFinite()) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `AssetBalanceChange.fromHr: input must be finite (got ${hr.toString()})`,
      );
    }
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `AssetBalanceChange.fromHr: decimals must be a non-negative integer (got ${decimals})`,
      );
    }
    return new AssetBalanceChange(hrDecimalToMinorUnits(hr, decimals), decimals);
  }

  /**
   * Human-readable amount as a `Decimal` — mirrors Python's
   * `AbstractAssetBalanceChange.balance_change_hr`. Derived lazily from
   * the bigint source-of-truth via an EXACT string-shift path
   * (`minorUnitsToHrString`) so the returned `Decimal` carries every
   * wei/lamport/satoshi. Note: consumers reading the `Decimal` and
   * feeding it back through decimal.js arithmetic (`.mul`, `.div`)
   * may still lose precision at decimal.js's 20-sig-digit default —
   * for exact reconciliation stay on `balanceChangeMr`.
   */
  get balanceChangeHr(): Decimal {
    return new Decimal(minorUnitsToHrString(this.balanceChangeMr, this.decimals));
  }

  /**
   * Sum two changes. Uses `this.decimals` for the result — mirrors Python
   * `AbstractAssetBalanceChange.__add__` (base/base.py:239-311) which
   * uses `self._decimals`. No decimals-mismatch check; consumers that
   * care compare `.decimals` themselves before adding.
   */
  add(other: AssetBalanceChange): AssetBalanceChange {
    return new AssetBalanceChange(this.balanceChangeMr + other.balanceChangeMr, this.decimals);
  }

  /**
   * Merge `change` into `balanceChanges[wallet][assetHash]`. Mirrors
   * Python `AssetBalanceChange.upsert` (base/base.py:255-287): mutating,
   * returns void; zero-net collapses both the asset row and the wallet
   * row (when the wallet's inner map empties); on non-zero-net merge the
   * newer `change.decimals` wins (Python uses `change._decimals`, not
   * `existing._decimals`).
   *
   * No decimals-mismatch throw. Python does not check either — the newer
   * change's decimals silently win. Consumers with a decimals-consistency
   * requirement enforce it externally.
   */
  static upsert(
    balanceChanges: NestedBalanceChanges,
    wallet: string,
    token: Token,
    change: AssetBalanceChange,
  ): void {
    const hash = assetHashOf(token);
    let perWallet = balanceChanges.get(wallet);
    if (!perWallet) {
      perWallet = new Map();
      balanceChanges.set(wallet, perWallet);
    }
    const existing = perWallet.get(hash);
    if (!existing) {
      // Symmetric with the zero-net merge branch below: don't create a
      // "no change" row for a zero delta. balanceChangesExcludingFees
      // can hit this when a fee_payer with no existing row is credited
      // with fee_lamports === 0n (subsidised chains). If the perWallet
      // Map was just created for this insert, drop it to keep the
      // container empty.
      if (change.balanceChangeMr === 0n) {
        if (perWallet.size === 0) balanceChanges.delete(wallet);
        return;
      }
      perWallet.set(hash, { token, change });
      return;
    }
    const netMr = existing.change.balanceChangeMr + change.balanceChangeMr;
    if (netMr === 0n) {
      perWallet.delete(hash);
      if (perWallet.size === 0) balanceChanges.delete(wallet);
      return;
    }
    perWallet.set(hash, {
      token,
      change: new AssetBalanceChange(netMr, change.decimals),
    });
  }

  toString(): string {
    // Emit both the exact bigint (never lossy) and the human-readable
    // string derived via minorUnitsToHrString (also exact — no decimal.js
    // rounding). Neither field can drop wei.
    return `[change:${minorUnitsToHrString(this.balanceChangeMr, this.decimals)}(hr) / ${this.balanceChangeMr}(mr)]`;
  }
}

export interface TransactionErrorInfo {
  code?: string;
  reason?: string;
}

export interface TransactionStatusInit {
  chainId: number;
  status: TransactionStatusType;
  inclusionAt?: Date | null;
  error?: TransactionErrorInfo | null;
  balanceChanges?: NestedBalanceChanges | null;
}

export abstract class TransactionStatus {
  readonly chainId: number;
  readonly status: TransactionStatusType;
  readonly inclusionAt: Date | null;
  readonly error: TransactionErrorInfo | null;
  readonly balanceChanges: NestedBalanceChanges | null;

  protected constructor(init: TransactionStatusInit) {
    const { chainId, status } = init;
    const inclusionAt = init.inclusionAt ?? null;
    const error = init.error ?? null;
    const balanceChanges = init.balanceChanges ?? null;

    switch (status) {
      case TransactionStatusTypes.Success:
        if (balanceChanges === null) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `TransactionStatus(Success) requires balanceChanges; chainId=${chainId}`,
          );
        }
        if (error !== null) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `TransactionStatus(Success) must have null error; chainId=${chainId}`,
          );
        }
        break;
      case TransactionStatusTypes.Failed:
        if (balanceChanges !== null) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `TransactionStatus(Failed) must have null balanceChanges; chainId=${chainId}`,
          );
        }
        if (error === null) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `TransactionStatus(Failed) requires error; chainId=${chainId}`,
          );
        }
        break;
      case TransactionStatusTypes.NotFound:
        if (balanceChanges !== null) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `TransactionStatus(NotFound) must have null balanceChanges; chainId=${chainId}`,
          );
        }
        break;
      case TransactionStatusTypes.Pending:
        if (balanceChanges !== null) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `TransactionStatus(Pending) must have null balanceChanges; chainId=${chainId}`,
          );
        }
        if (error !== null) {
          throw new ChainError(
            ChainErrorKinds.InvalidArgument,
            `TransactionStatus(Pending) must have null error; chainId=${chainId}`,
          );
        }
        break;
      default: {
        const _exhaustive: never = status;
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `Unknown TransactionStatusType: ${String(_exhaustive)}`,
        );
      }
    }

    this.chainId = chainId;
    this.status = status;
    this.inclusionAt = inclusionAt;
    this.error = error;
    this.balanceChanges = balanceChanges;
  }
}

export function isSuccess(
  s: TransactionStatus,
): s is TransactionStatus & { balanceChanges: NestedBalanceChanges; error: null } {
  return s.status === TransactionStatusTypes.Success;
}

export function isFailed(
  s: TransactionStatus,
): s is TransactionStatus & { balanceChanges: null; error: TransactionErrorInfo } {
  return s.status === TransactionStatusTypes.Failed;
}

export function isPending(
  s: TransactionStatus,
): s is TransactionStatus & { balanceChanges: null; error: null } {
  return s.status === TransactionStatusTypes.Pending;
}

export function isNotFound(
  s: TransactionStatus,
): s is TransactionStatus & { balanceChanges: null } {
  return s.status === TransactionStatusTypes.NotFound;
}
