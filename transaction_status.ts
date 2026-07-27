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
 * Wave 2A ships bigint-only. The Python-parity `balance_change_hr: Decimal`
 * accessor lands in Wave 2B alongside the `decimal.js` consumer install
 * PRs; until then callers who need a human-readable representation compute
 * it themselves from `balanceChangeMr` and `decimals`.
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
    return `[change:${this.balanceChangeMr.toString()}(mr)]`;
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
