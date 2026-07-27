import { ChainError, ChainErrorKinds } from '../errors.ts';
import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
} from '../transaction_status.ts';

export interface UtxoTransactionFeesInit {
  absoluteSats: bigint;
  vsize: number | null;
}

export class UtxoTransactionFees {
  readonly absoluteSats: bigint;
  readonly vsize: number | null;

  constructor(init: UtxoTransactionFeesInit) {
    if (init.absoluteSats < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `UtxoTransactionFees.absoluteSats must be >= 0, got ${init.absoluteSats}`,
      );
    }
    if (init.vsize !== null && (!Number.isFinite(init.vsize) || init.vsize < 0)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `UtxoTransactionFees.vsize must be a non-negative number or null, got ${init.vsize}`,
      );
    }
    this.absoluteSats = init.absoluteSats;
    this.vsize = init.vsize;
  }

  /** Fee rate in sat/vB. `null` when vsize is null or zero. */
  get satsPerVByte(): number | null {
    if (this.vsize === null || this.vsize === 0) return null;
    return Number(this.absoluteSats) / this.vsize;
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
    if (init.valueSats < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `UtxoTransactionOutput.valueSats must be >= 0, got ${init.valueSats}`,
      );
    }
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
  outputs?: readonly UtxoTransactionOutput[] | null;
  vsize?: number | null;
  confirmations?: number | null;
  fees?: UtxoTransactionFees | null;
}

/**
 * UTXO tx status. Python parity: no static factory methods; consumers build
 * via the constructor directly (impl/utxo/base.py:677-728). Adds `fees` for
 * parity with EVM/Solana subclass surfaces — Python's UTXO base omits it,
 * but the consumer's deposit-detector needs the fee to reconcile net-of-fee
 * balances. Documented deviation in SINAN_OPEN_QUESTIONS.md.
 *
 * **Important semantic caveat vs EVM/Solana**: `balanceChanges` on
 * `UtxoTransactionStatus` are **gross output credits** per receiving
 * address, NOT net per-wallet deltas. UTXO tools currently return only
 * `vin.txid` + `vout` from providers — no per-input address/value — so the
 * SDK can't debit inputs. A hot-wallet withdrawal will therefore record
 * that wallet's own **change output** as a positive `AssetBalanceChange`,
 * NOT a net debit. Consumers doing uniform cross-chain balance
 * reconciliation must special-case UTXO. Input-side accounting is deferred
 * to a later phase; see `docs/UPGRADE_TO_V0_2A.md` under "UTXO
 * balanceChanges semantics" and SINAN_OPEN_QUESTIONS.md.
 *
 * `inputs` is not yet surfaced (the raw-tx provider returns only txid+vout,
 * insufficient for a meaningful shape). Comes back in the 2C UTXO port.
 */
export class UtxoTransactionStatus extends TransactionStatus {
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
    if (init.vsize !== undefined && init.vsize !== null && init.vsize < 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `UtxoTransactionStatus.vsize must be >= 0 or null, got ${init.vsize}`,
      );
    }
    if (init.confirmations !== undefined && init.confirmations !== null && init.confirmations < 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `UtxoTransactionStatus.confirmations must be >= 0 or null, got ${init.confirmations}`,
      );
    }
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
