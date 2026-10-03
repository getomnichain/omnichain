import { ChainError, ChainErrorKinds } from '../errors.ts';
import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';

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
}

export class TronTransactionStatus extends TransactionStatus {
  readonly fees: TronTransactionFees | null;

  constructor(init: TronTransactionStatusInit) {
    super({
      chainId: init.chainId,
      status: init.status,
      inclusionAt: init.inclusionAt,
      balanceChanges: init.balanceChanges,
      error: init.error,
    });
    this.fees = init.fees ?? null;
  }

  static successful(args: {
    chainId: number;
    inclusionAt: Date;
    balanceChanges: NestedBalanceChanges;
    fees: TronTransactionFees;
  }): TronTransactionStatus {
    return new TronTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Success,
      inclusionAt: args.inclusionAt,
      balanceChanges: args.balanceChanges,
      error: null,
      fees: args.fees,
    });
  }

  static failed(args: {
    chainId: number;
    inclusionAt: Date | null;
    error: TransactionErrorInfo;
    fees?: TronTransactionFees | null;
  }): TronTransactionStatus {
    return new TronTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Failed,
      inclusionAt: args.inclusionAt,
      balanceChanges: null,
      error: args.error,
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
