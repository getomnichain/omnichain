import Decimal from 'decimal.js';

import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
} from '../transaction_status.ts';

export interface UtxoTransactionInputInit {
  txid: string;
  vout: number;
  scriptPubkeyHex: string;
  address: string | null;
  value: Decimal;
}

export class UtxoTransactionInput {
  readonly txid: string;
  readonly vout: number;
  readonly scriptPubkeyHex: string;
  readonly address: string | null;
  readonly value: Decimal;

  constructor(init: UtxoTransactionInputInit) {
    this.txid = init.txid;
    this.vout = init.vout;
    this.scriptPubkeyHex = init.scriptPubkeyHex;
    this.address = init.address;
    this.value = init.value;
  }
}

export interface UtxoTransactionOutputInit {
  scriptPubkeyHex: string;
  address: string | null;
  value: Decimal;
}

export class UtxoTransactionOutput {
  readonly scriptPubkeyHex: string;
  readonly address: string | null;
  readonly value: Decimal;

  constructor(init: UtxoTransactionOutputInit) {
    this.scriptPubkeyHex = init.scriptPubkeyHex;
    this.address = init.address;
    this.value = init.value;
  }
}

export interface UtxoTransactionStatusInit {
  chainId: number;
  status: TransactionStatusType;
  /**
   * Aliased to the parent `inclusionAt`. Named `confirmationAt` here to
   * mirror Python's `UtxoTransactionStatus.__init__` param
   * `confirmation_datetime_utc` (impl/utxo/base.py:682).
   */
  confirmationAt?: Date | null;
  balanceChanges?: NestedBalanceChanges | null;
  error?: TransactionErrorInfo | null;
  inputs?: readonly UtxoTransactionInput[] | null;
  outputs?: readonly UtxoTransactionOutput[] | null;
  vsize?: number | null;
  confirmations?: number | null;
}

/**
 * UTXO tx status. Python parity: no static factory methods; consumers build
 * via the constructor directly (impl/utxo/base.py:677-728).
 */
export class UtxoTransactionStatus extends TransactionStatus {
  readonly inputs: readonly UtxoTransactionInput[] | null;
  readonly outputs: readonly UtxoTransactionOutput[] | null;
  readonly vsize: number | null;
  readonly confirmations: number | null;

  constructor(init: UtxoTransactionStatusInit) {
    super({
      chainId: init.chainId,
      status: init.status,
      inclusionAt: init.confirmationAt,
      error: init.error,
      balanceChanges: init.balanceChanges,
    });
    this.inputs = init.inputs ?? null;
    this.outputs = init.outputs ?? null;
    this.vsize = init.vsize ?? null;
    this.confirmations = init.confirmations ?? null;
  }

  /**
   * Alias for the parent's `inclusionAt` field, exposed under the Python name
   * `confirmationAt` for readability at consumer call sites. Same underlying
   * value; do not use both interchangeably in diffs.
   */
  get confirmationAt(): Date | null {
    return this.inclusionAt;
  }
}
