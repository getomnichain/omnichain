import Decimal from 'decimal.js';

import { ChainError, ChainErrorKinds } from '../errors.ts';
import { Token } from '../token.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';

export interface SolanaTransactionFeesInit {
  feePayer: string;
  feeLamports: bigint;
  computeUnitsConsumed: bigint;
  netLamportsChangeByFeePayer: bigint;
}

export class SolanaTransactionFees {
  readonly feePayer: string;
  readonly feeLamports: bigint;
  readonly computeUnitsConsumed: bigint;
  readonly netLamportsChangeByFeePayer: bigint;

  constructor(init: SolanaTransactionFeesInit) {
    if (init.feePayer.length === 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'SolanaTransactionFees.feePayer must be non-empty',
      );
    }
    if (init.feeLamports <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `SolanaTransactionFees.feeLamports must be > 0, got ${init.feeLamports}`,
      );
    }
    if (init.computeUnitsConsumed <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `SolanaTransactionFees.computeUnitsConsumed must be > 0, got ${init.computeUnitsConsumed}`,
      );
    }
    this.feePayer = init.feePayer;
    this.feeLamports = init.feeLamports;
    this.computeUnitsConsumed = init.computeUnitsConsumed;
    this.netLamportsChangeByFeePayer = init.netLamportsChangeByFeePayer;
  }
}

export interface SolanaTransactionStatusInit {
  chainId: number;
  status: TransactionStatusType;
  inclusionAt?: Date | null;
  balanceChanges?: NestedBalanceChanges | null;
  error?: TransactionErrorInfo | null;
  fees?: SolanaTransactionFees | null;
}

export class SolanaTransactionStatus extends TransactionStatus {
  readonly fees: SolanaTransactionFees | null;

  constructor(init: SolanaTransactionStatusInit) {
    super({
      chainId: init.chainId,
      status: init.status,
      inclusionAt: init.inclusionAt,
      error: init.error,
      balanceChanges: init.balanceChanges,
    });
    this.fees = init.fees ?? null;
  }

  static successful(args: {
    chainId: number;
    inclusionAt: Date;
    balanceChanges: NestedBalanceChanges;
    fees: SolanaTransactionFees;
  }): SolanaTransactionStatus {
    return new SolanaTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Success,
      inclusionAt: args.inclusionAt,
      balanceChanges: args.balanceChanges,
      fees: args.fees,
      error: null,
    });
  }

  static failed(args: {
    chainId: number;
    inclusionAt: Date;
    error: TransactionErrorInfo;
    fees: SolanaTransactionFees;
  }): SolanaTransactionStatus {
    return new SolanaTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Failed,
      inclusionAt: args.inclusionAt,
      error: args.error,
      balanceChanges: null,
      fees: args.fees,
    });
  }

  static pending(chainId: number): SolanaTransactionStatus {
    return new SolanaTransactionStatus({
      chainId,
      status: TransactionStatusTypes.Pending,
      inclusionAt: null,
      error: null,
      balanceChanges: null,
      fees: null,
    });
  }

  static notFound(
    chainId: number,
    error: TransactionErrorInfo | null = null,
  ): SolanaTransactionStatus {
    return new SolanaTransactionStatus({
      chainId,
      status: TransactionStatusTypes.NotFound,
      inclusionAt: null,
      error,
      balanceChanges: null,
      fees: null,
    });
  }

  /**
   * Deep-copies `balanceChanges` and reverses the fee debit on the fee_payer's
   * native row — mirrors omnichain-py `SolanaTransactionStatus.balance_changes_excluding_fees`
   * (impl/solana/base.py). Solana's raw balance deltas already include the
   * fee_payer's fee debit; this helper strips it so callers see gross-of-fee
   * balance movements.
   */
  balanceChangesExcludingFees(nativeAsset: Token): NestedBalanceChanges {
    if (this.balanceChanges === null) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'balanceChangesExcludingFees requires a non-null balanceChanges',
      );
    }
    if (this.fees === null) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'balanceChangesExcludingFees requires non-null fees to know which fee_payer to credit',
      );
    }
    const copy: NestedBalanceChanges = new Map();
    for (const [wallet, perWallet] of this.balanceChanges) {
      const inner = new Map<string, { token: Token; change: AssetBalanceChange }>();
      for (const [hash, entry] of perWallet) {
        inner.set(hash, {
          token: entry.token,
          change: new AssetBalanceChange(
            new Decimal(entry.change.balanceChangeHr),
            entry.change.decimals,
          ),
        });
      }
      copy.set(wallet, inner);
    }
    const feeAsHr = new Decimal(this.fees.feeLamports.toString()).div(
      new Decimal(10).pow(nativeAsset.decimals),
    );
    AssetBalanceChange.upsert(
      copy,
      this.fees.feePayer,
      nativeAsset,
      new AssetBalanceChange(feeAsHr, nativeAsset.decimals),
    );
    return copy;
  }
}
