import { ChainError, ChainErrorKinds } from '../errors.ts';
import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
} from '../transaction_status.ts';
import { UtxoInputsUnresolvedReason, UtxoTransactionInput } from './utxo.ts';

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
  inputs?: readonly UtxoTransactionInput[] | null;
  inputsUnresolvedReason?: UtxoInputsUnresolvedReason | null;
}

/**
 * UTXO tx status. Python parity: `balanceChanges` are **net per-address
 * deltas** derived from `UtxoTransaction.netChangesHr` in the provider tool
 * (impl/utxo/base.py:1874-1890) — inputs are debited, outputs credited, so
 * a self-send or a hot-wallet withdrawal shows its net delta directly. Same
 * shape as `EvmTransactionStatus` and `SolanaTransactionStatus`.
 *
 * `inputs` is populated when the provider tool's `getTransactionWithInputs`
 * could hydrate every non-coinbase input's prevout; `null` (with
 * `inputsUnresolvedReason` set) when hydration was incomplete
 * (`provider_error` | `parent_missing` | `pending`). When `inputs` is
 * `null`, `balanceChanges` is also `null` — the SDK does not present a
 * partial or gross map as though it were the net one.
 *
 * Deposit detectors that only need who was credited (gross output credits
 * per address) should iterate `outputs[]` directly; there is no
 * `outputCreditsByAddress()` helper and no legacy gross-credits field.
 */
export class UtxoTransactionStatus extends TransactionStatus {
  readonly outputs: readonly UtxoTransactionOutput[] | null;
  readonly vsize: number | null;
  readonly confirmations: number | null;
  readonly fees: UtxoTransactionFees | null;
  readonly inputs: readonly UtxoTransactionInput[] | null;
  readonly inputsUnresolvedReason: UtxoInputsUnresolvedReason | null;

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
    this.inputs = init.inputs ?? null;
    this.inputsUnresolvedReason = init.inputsUnresolvedReason ?? null;
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
