import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
} from '../transaction_status.ts';

export interface UtxoTransactionFeesInit {
  absoluteSats: bigint;
  vsize: number;
}

export class UtxoTransactionFees {
  readonly absoluteSats: bigint;
  readonly vsize: number;

  constructor(init: UtxoTransactionFeesInit) {
    this.absoluteSats = init.absoluteSats;
    this.vsize = init.vsize;
  }

  /** Fee rate in sat/vB, `null` if `vsize` is 0. */
  get satsPerVByte(): number | null {
    if (this.vsize === 0) return null;
    return Number(this.absoluteSats) / this.vsize;
  }
}

export interface UtxoTransactionInputInit {
  txid: string;
  vout: number;
  scriptPubkeyHex: string;
  address: string | null;
  valueSats: bigint;
}

export class UtxoTransactionInput {
  readonly txid: string;
  readonly vout: number;
  readonly scriptPubkeyHex: string;
  readonly address: string | null;
  readonly valueSats: bigint;

  constructor(init: UtxoTransactionInputInit) {
    this.txid = init.txid;
    this.vout = init.vout;
    this.scriptPubkeyHex = init.scriptPubkeyHex;
    this.address = init.address;
    this.valueSats = init.valueSats;
  }
}

export interface UtxoTransactionOutputInit {
  scriptPubkeyHex: string;
  address: string | null;
  valueSats: bigint;
}

export class UtxoTransactionOutput {
  readonly scriptPubkeyHex: string;
  readonly address: string | null;
  readonly valueSats: bigint;

  constructor(init: UtxoTransactionOutputInit) {
    this.scriptPubkeyHex = init.scriptPubkeyHex;
    this.address = init.address;
    this.valueSats = init.valueSats;
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
  fees?: UtxoTransactionFees | null;
}

/**
 * UTXO tx status. Python parity: no static factory methods; consumers build
 * via the constructor directly (impl/utxo/base.py:677-728). Adds a `fees`
 * field for parity with EVM/Solana subclass surfaces — Python's UTXO base
 * omits it, but the consumer's deposit-detector needs the fee to reconcile
 * net-of-fee balances. Documented deviation in SINAN_OPEN_QUESTIONS.md.
 */
export class UtxoTransactionStatus extends TransactionStatus {
  readonly inputs: readonly UtxoTransactionInput[] | null;
  readonly outputs: readonly UtxoTransactionOutput[] | null;
  readonly vsize: number | null;
  readonly confirmations: number | null;
  readonly fees: UtxoTransactionFees | null;

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
    this.fees = init.fees ?? null;
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
