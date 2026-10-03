import { UnsignedTransaction } from './unsigned_transaction.ts';

export abstract class AbstractTransactionPrerequisite {
  abstract get chainId(): number;
}

export abstract class AbstractHandledPrerequisiteResponse {
  abstract get skipped(): boolean;
}

export interface UnsignedTransactionWithPrerequisitesInit<
  T extends UnsignedTransaction,
  P extends AbstractTransactionPrerequisite,
> {
  prerequisites: P[];
  transaction: T;
}

export class UnsignedTransactionWithPrerequisites<
  T extends UnsignedTransaction = UnsignedTransaction,
  P extends AbstractTransactionPrerequisite = AbstractTransactionPrerequisite,
> {
  readonly prerequisites: P[];
  readonly transaction: T;

  constructor(init: UnsignedTransactionWithPrerequisitesInit<T, P>) {
    this.prerequisites = init.prerequisites;
    this.transaction = init.transaction;
  }
}
