import { Memo } from '@stellar/stellar-sdk';

import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';
import { StellarTransactionFees } from './stellar_transactions.ts';

export interface StellarTransactionStatusInit {
  chainId: number;
  status: TransactionStatusType;
  inclusionAt?: Date | null;
  balanceChanges?: NestedBalanceChanges | null;
  error?: TransactionErrorInfo | null;
  horizonPagingToken?: string | null;
  fees?: StellarTransactionFees | null;
  memo?: Memo | null;
}

export class StellarTransactionStatus extends TransactionStatus {
  readonly horizonPagingToken: string | null;
  readonly fees: StellarTransactionFees | null;
  readonly memo: Memo | null;

  constructor(init: StellarTransactionStatusInit) {
    super({
      chainId: init.chainId,
      status: init.status,
      inclusionAt: init.inclusionAt,
      balanceChanges: init.balanceChanges,
      error: init.error,
    });
    this.horizonPagingToken = init.horizonPagingToken ?? null;
    this.fees = init.fees ?? null;
    this.memo = init.memo ?? null;
  }

  static successful(args: {
    chainId: number;
    inclusionAt: Date;
    balanceChanges: NestedBalanceChanges;
    fees?: StellarTransactionFees | null;
    memo?: Memo | null;
    horizonPagingToken?: string | null;
  }): StellarTransactionStatus {
    return new StellarTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Success,
      inclusionAt: args.inclusionAt,
      balanceChanges: args.balanceChanges,
      error: null,
      horizonPagingToken: args.horizonPagingToken ?? null,
      fees: args.fees ?? null,
      memo: args.memo ?? null,
    });
  }

  static failed(args: {
    chainId: number;
    inclusionAt: Date | null;
    error: TransactionErrorInfo;
    fees?: StellarTransactionFees | null;
    memo?: Memo | null;
    horizonPagingToken?: string | null;
  }): StellarTransactionStatus {
    return new StellarTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Failed,
      inclusionAt: args.inclusionAt,
      balanceChanges: null,
      error: args.error,
      horizonPagingToken: args.horizonPagingToken ?? null,
      fees: args.fees ?? null,
      memo: args.memo ?? null,
    });
  }

  static pending(chainId: number): StellarTransactionStatus {
    return new StellarTransactionStatus({
      chainId,
      status: TransactionStatusTypes.Pending,
      inclusionAt: null,
      balanceChanges: null,
      error: null,
    });
  }

  static notFound(chainId: number, error: TransactionErrorInfo | null = null): StellarTransactionStatus {
    return new StellarTransactionStatus({
      chainId,
      status: TransactionStatusTypes.NotFound,
      inclusionAt: null,
      balanceChanges: null,
      error,
    });
  }
}
