import { NestedBalanceChanges } from './transaction_status.ts';

export const TransactionSimulationStatusTypes = {
  Success: 'Success',
  Failed: 'Failed',
} as const;

export type TransactionSimulationStatusType =
  (typeof TransactionSimulationStatusTypes)[keyof typeof TransactionSimulationStatusTypes];

export interface TransactionSimulationResultInit {
  chainId: number;
  statusType: TransactionSimulationStatusType;
  balanceChanges: NestedBalanceChanges;
  error: Error | null;
}

export abstract class AbstractTransactionSimulationResult {
  readonly chainId: number;
  readonly statusType: TransactionSimulationStatusType;
  readonly balanceChanges: NestedBalanceChanges;
  readonly error: Error | null;

  protected constructor(init: TransactionSimulationResultInit) {
    this.chainId = init.chainId;
    this.statusType = init.statusType;
    this.balanceChanges = init.balanceChanges;
    this.error = init.error;
  }
}
