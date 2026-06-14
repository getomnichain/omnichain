import { Token } from './token.ts';

export const TransactionStatusTypes = {
  Success: 'Success',
  Failed: 'Failed',
  Pending: 'Pending',
  NotFound: 'NotFound',
} as const;

export type TransactionStatusType =
  (typeof TransactionStatusTypes)[keyof typeof TransactionStatusTypes];

export interface BalanceChange {
  address: string;
  token: Token;
  amount: bigint;
}

export interface GasFee {
  token: Token;
  amount: bigint;
}

export interface TransactionErrorInfo {
  code?: string;
  reason?: string;
}

export interface TransactionStatus {
  status: TransactionStatusType;
  confirmations: number | null;
  blockNumber: number | null;
  txTimestamp: Date | null;
  balanceChanges: BalanceChange[];
  gasFee: GasFee | null;
  errorInfo: TransactionErrorInfo | null;
}
