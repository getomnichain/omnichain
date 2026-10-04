import { Memo } from '@stellar/stellar-sdk';

import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';
import { StellarTransactionFees, pyMemoStr } from './stellar_transactions.ts';
import { pyBalanceChangesRepr, pyStr } from '../python_repr.ts';

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

  toString(): string {
    return (
      `StellarTransactionStatus[chainId:${this.chainId}, status_type:${this.status}, fee:${pyStr(this.fees)}, ` +
      `paging_token:${pyStr(this.horizonPagingToken)}, balance_changes:${pyBalanceChangesRepr(this.balanceChanges)}, ` +
      `error:${this.error === null ? 'None' : (this.error.reason ?? this.error.code)}, memo:${this.memo === null ? 'None' : pyMemoStr(this.memo)})]`
    );
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
