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

export function assetHashOf(token: Token): string {
  return `${token.chainId}_${token.symbol}_${token.identifier ?? ''}_${token.decimals}`;
}

export interface AssetBalanceChangeEntry {
  token: Token;
  change: AssetBalanceChange;
}

export type NestedBalanceChanges = Map<string, Map<string, AssetBalanceChangeEntry>>;

export class AssetBalanceChange {
  readonly balanceChangeHr: Decimal;
  readonly balanceChangeMr: bigint;
  readonly decimals: number;

  constructor(balanceChangeHr: Decimal, decimals: number) {
    if (!Number.isInteger(decimals) || decimals < 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `AssetBalanceChange decimals must be a non-negative integer, got ${decimals}`,
      );
    }
    this.balanceChangeHr = balanceChangeHr;
    this.decimals = decimals;
    this.balanceChangeMr = hrToMr(balanceChangeHr, decimals);
  }

  static zero(decimals: number = 0): AssetBalanceChange {
    return new AssetBalanceChange(new Decimal(0), decimals);
  }

  static fromMr(balanceChangeMr: bigint, decimals: number): AssetBalanceChange {
    return new AssetBalanceChange(mrToHr(balanceChangeMr, decimals), decimals);
  }

  add(other: AssetBalanceChange): AssetBalanceChange {
    return new AssetBalanceChange(
      this.balanceChangeHr.plus(other.balanceChangeHr),
      this.decimals,
    );
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
    const net = existing.change.balanceChangeHr.plus(change.balanceChangeHr);
    if (net.isZero()) {
      perWallet.delete(hash);
      if (perWallet.size === 0) balanceChanges.delete(wallet);
      return;
    }
    perWallet.set(hash, {
      token,
      change: new AssetBalanceChange(net, change.decimals),
    });
  }

  toString(): string {
    return `[change:${this.balanceChangeHr.toString()}]`;
  }
}

function hrToMr(hr: Decimal, decimals: number): bigint {
  const shifted = hr.mul(new Decimal(10).pow(decimals));
  const rounded = shifted.trunc();
  return BigInt(rounded.toFixed(0));
}

function mrToHr(mr: bigint, decimals: number): Decimal {
  return new Decimal(mr.toString()).div(new Decimal(10).pow(decimals));
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
