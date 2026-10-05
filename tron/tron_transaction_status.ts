import { ChainError, ChainErrorKinds } from '../errors.ts';
import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';
import { pyBalanceChangesRepr, pyDatetimeStr, pyStr } from '../python_repr.ts';

export interface TronTransactionFeesInit {
  feeInSun: number;
  energyUsage: number;
  energyFee: number;
  originEnergyUsage: number;
  energyUsageTotal: number;
  netUsage: number;
  netFee: number;
  energyPenaltyTotal: number;
  chainParamGetEnergyFee: number;
}

export class TronTransactionFees {
  readonly feeInSun: number;
  readonly energyUsage: number;
  readonly energyFee: number;
  readonly originEnergyUsage: number;
  readonly energyUsageTotal: number;
  readonly netUsage: number;
  readonly netFee: number;
  readonly energyPenaltyTotal: number;
  readonly chainParamGetEnergyFee: number;

  constructor(init: TronTransactionFeesInit) {
    for (const [field, value] of Object.entries(init)) {
      if (!Number.isSafeInteger(value)) {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `TronTransactionFees.${field} must be an integer, got ${value}`);
      }
    }
    const expectedTotal =
      init.energyUsage + init.originEnergyUsage + Math.trunc(init.energyFee / init.chainParamGetEnergyFee);
    if (init.energyUsageTotal !== expectedTotal) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `TronTransactionFees.energyUsageTotal (${init.energyUsageTotal}) must equal energyUsage + originEnergyUsage + energyFee / chainParamGetEnergyFee (${expectedTotal})`,
      );
    }
    this.feeInSun = init.feeInSun;
    this.energyUsage = init.energyUsage;
    this.energyFee = init.energyFee;
    this.originEnergyUsage = init.originEnergyUsage;
    this.energyUsageTotal = init.energyUsageTotal;
    this.netUsage = init.netUsage;
    this.netFee = init.netFee;
    this.energyPenaltyTotal = init.energyPenaltyTotal;
    this.chainParamGetEnergyFee = init.chainParamGetEnergyFee;
  }

  toString(): string {
    return (
      `fee_in_sun=${this.feeInSun} energy_usage=${this.energyUsage} energy_fee=${this.energyFee} ` +
      `origin_energy_usage=${this.originEnergyUsage} energy_usage_total=${this.energyUsageTotal} net_usage=${this.netUsage} ` +
      `net_fee=${this.netFee} energy_penalty_total=${this.energyPenaltyTotal} chain_param_get_energy_fee=${this.chainParamGetEnergyFee}`
    );
  }

  static fromTransactionInfo(info: Record<string, unknown>, chainGetEnergyFee: number): TronTransactionFees {
    const receipt = (info.receipt as Record<string, unknown> | undefined) ?? {};
    const int = (value: unknown): number => (value ? Math.trunc(Number(value)) : 0);
    return new TronTransactionFees({
      feeInSun: int(info.fee),
      energyUsage: int(receipt.energy_usage),
      energyFee: int(receipt.energy_fee),
      originEnergyUsage: int(receipt.origin_energy_usage),
      energyUsageTotal: int(receipt.energy_usage_total),
      netUsage: int(receipt.net_usage),
      netFee: int(receipt.net_fee),
      energyPenaltyTotal: int(receipt.energy_penalty_total),
      chainParamGetEnergyFee: chainGetEnergyFee,
    });
  }
}

export interface TronTransactionStatusInit {
  chainId: number;
  status: TransactionStatusType;
  inclusionAt?: Date | null;
  balanceChanges?: NestedBalanceChanges | null;
  error?: TransactionErrorInfo | null;
  fees?: TronTransactionFees | null;
  blockNumber?: number | null;
  signers?: readonly string[];
  memo?: string | null;
  memoHex?: string | null;
}

export interface TronIncludedTransactionDetails {
  blockNumber?: number | null;
  signers?: readonly string[];
  memo?: string | null;
  memoHex?: string | null;
}

export class TronTransactionStatus extends TransactionStatus {
  readonly fees: TronTransactionFees | null;
  readonly blockNumber: number | null;
  readonly signers: readonly string[];
  readonly memo: string | null;
  readonly memoHex: string | null;

  constructor(init: TronTransactionStatusInit) {
    super({
      chainId: init.chainId,
      status: init.status,
      inclusionAt: init.inclusionAt,
      balanceChanges: init.balanceChanges,
      error: init.error,
    });
    this.fees = init.fees ?? null;
    this.blockNumber = init.blockNumber ?? null;
    this.signers = init.signers ?? [];
    this.memo = init.memo ?? null;
    this.memoHex = init.memoHex ?? null;
  }

  toString(): string {
    return (
      `TronTransactionStatus[chain_id=${this.chainId}, status_type=${this.status}, ` +
      `inclusion_datetime_utc=${pyDatetimeStr(this.inclusionAt)}, ` +
      `fees=${pyStr(this.fees)}, balance_changes=${pyBalanceChangesRepr(this.balanceChanges)}]`
    );
  }

  static successful(
    args: {
      chainId: number;
      inclusionAt: Date;
      balanceChanges: NestedBalanceChanges;
      fees: TronTransactionFees;
    } & TronIncludedTransactionDetails,
  ): TronTransactionStatus {
    return new TronTransactionStatus({
      ...args,
      status: TransactionStatusTypes.Success,
      error: null,
    });
  }

  static failed(
    args: {
      chainId: number;
      inclusionAt: Date | null;
      error: TransactionErrorInfo;
      fees?: TronTransactionFees | null;
    } & TronIncludedTransactionDetails,
  ): TronTransactionStatus {
    return new TronTransactionStatus({
      ...args,
      status: TransactionStatusTypes.Failed,
      balanceChanges: null,
      fees: args.fees ?? null,
    });
  }

  static pending(chainId: number): TronTransactionStatus {
    return new TronTransactionStatus({
      chainId,
      status: TransactionStatusTypes.Pending,
      inclusionAt: null,
      balanceChanges: null,
      error: null,
      fees: null,
    });
  }

  static notFound(chainId: number, error: TransactionErrorInfo | null = null): TronTransactionStatus {
    return new TronTransactionStatus({
      chainId,
      status: TransactionStatusTypes.NotFound,
      inclusionAt: null,
      balanceChanges: null,
      error,
      fees: null,
    });
  }
}
