import Decimal from 'decimal.js';

import { ChainError, ChainErrorKinds } from './errors.ts';
import { Token } from './token.ts';

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
 * `(chainId, symbol, identifier)` — matches `Token.equals` (which excludes
 * decimals per Python parity). Decimals are preserved on the stored entry's
 * `token` for display, but MUST NOT split the same asset into two rows
 * on a source-vs-destination decimals disagreement — that would leave
 * both legs of a transfer uncancelled and report a phantom double movement.
 */
export function assetHashOf(token: Token): string {
  return `${token.chainId}_${token.symbol}_${token.identifier ?? ''}`;
}

export interface AssetBalanceChangeEntry {
  token: Token;
  change: AssetBalanceChange;
}

export type NestedBalanceChanges = Map<string, Map<string, AssetBalanceChangeEntry>>;

/**
 * Per-(wallet, asset) balance delta. Source of truth is `balanceChangeMr`
 * (bigint minor units) — exact and native to every on-chain representation.
 * `balanceChangeHr` (Decimal) is a lazy getter derived from mr / 10^decimals,
 * exposed for consumer display.
 *
 * Storage flip vs Python (which stores `balance_change_hr: Decimal` and
 * computes `balance_change_mr: int` in the constructor): decimal.js defaults
 * to 20 significant digits, so 18-decimal amounts ≥ ~100 tokens silently
 * truncate the last minor-unit digits on Decimal → bigint round-trip. Storing
 * bigint keeps every wei/lamport/satoshi exact; the Decimal accessor is
 * best-effort for human display and inherits decimal.js precision limits.
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

  get balanceChangeHr(): Decimal {
    return new Decimal(this.balanceChangeMr.toString()).div(
      new Decimal(10).pow(this.decimals),
    );
  }

  static zero(decimals: number = 0): AssetBalanceChange {
    return new AssetBalanceChange(0n, decimals);
  }

  static fromMr(balanceChangeMr: bigint, decimals: number): AssetBalanceChange {
    return new AssetBalanceChange(balanceChangeMr, decimals);
  }

  /**
   * `hr` is a display-oriented factory — accepts a `Decimal` or numeric string
   * and rounds via `hrToMr`. Prefer `fromMr` in decoders; use `hr` only when
   * you have a human amount and know the decimal.js precision is enough.
   */
  static fromHr(balanceChangeHr: Decimal | string, decimals: number): AssetBalanceChange {
    const hr = balanceChangeHr instanceof Decimal ? balanceChangeHr : new Decimal(balanceChangeHr);
    const shifted = hr.mul(new Decimal(10).pow(decimals));
    const rounded = shifted.trunc();
    return new AssetBalanceChange(BigInt(rounded.toFixed(0)), decimals);
  }

  add(other: AssetBalanceChange): AssetBalanceChange {
    if (other.decimals !== this.decimals) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `AssetBalanceChange.add: decimals mismatch (this=${this.decimals}, other=${other.decimals})`,
      );
    }
    return new AssetBalanceChange(this.balanceChangeMr + other.balanceChangeMr, this.decimals);
  }

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
      perWallet.set(hash, { token, change });
      return;
    }
    if (existing.change.decimals !== change.decimals) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `AssetBalanceChange.upsert: decimals mismatch for (${wallet}, ${hash}) — existing=${existing.change.decimals} vs incoming=${change.decimals}`,
      );
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
    return `[change:${this.balanceChangeHr.toFixed()}]`;
  }
}

export interface TransactionErrorInfo {
  code?: string;
  reason?: string;
  cause?: unknown;
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
