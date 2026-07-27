import { ChainError, ChainErrorKinds } from '../errors.ts';
import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';

export interface EvmTransactionGasFeesInit {
  gasLimit: bigint;
  gasLimitUsed: bigint;
  effectiveGasPrice: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export class EvmTransactionGasFees {
  readonly gasLimit: bigint;
  readonly gasLimitUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly gasPrice: bigint | undefined;
  readonly maxFeePerGas: bigint | undefined;
  readonly maxPriorityFeePerGas: bigint | undefined;

  constructor(init: EvmTransactionGasFeesInit) {
    // Observed on-chain values (not caller inputs) — reject negatives only.
    // Zero-gas / subsidised environments and pruned-node receipts return 0
    // for one or more of these fields; throwing there would turn
    // getTransactionStatus from "returns a status" into "throws".
    if (init.gasLimit < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmTransactionGasFees.gasLimit must be >= 0, got ${init.gasLimit}`,
      );
    }
    if (init.gasLimitUsed < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmTransactionGasFees.gasLimitUsed must be >= 0, got ${init.gasLimitUsed}`,
      );
    }
    if (init.effectiveGasPrice < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmTransactionGasFees.effectiveGasPrice must be >= 0, got ${init.effectiveGasPrice}`,
      );
    }
    this.gasLimit = init.gasLimit;
    this.gasLimitUsed = init.gasLimitUsed;
    this.effectiveGasPrice = init.effectiveGasPrice;
    this.gasPrice = init.gasPrice;
    this.maxFeePerGas = init.maxFeePerGas;
    this.maxPriorityFeePerGas = init.maxPriorityFeePerGas;
  }

  get totalGasInWei(): bigint {
    return this.gasLimitUsed * this.effectiveGasPrice;
  }
}

/**
 * Passive holder for an event log entry surfaced on a receipt. Parsing
 * (Transfer decoding, etc.) lives on the decoders in `evm_chain.ts`
 * where the address/casing normalisation happens alongside the
 * `NestedBalanceChanges` construction — a duplicate parser here would
 * drift out of sync.
 */
export class EvmParsedTransactionLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;

  constructor(address: string, topics: readonly string[], data: string) {
    this.address = address;
    this.topics = topics;
    this.data = data;
  }
}

export interface EvmTransactionStatusInit {
  chainId: number;
  status: TransactionStatusType;
  inclusionAt?: Date | null;
  error?: TransactionErrorInfo | null;
  balanceChanges?: NestedBalanceChanges | null;
  logs?: readonly EvmParsedTransactionLog[] | null;
  fees?: EvmTransactionGasFees | null;
}

export class EvmTransactionStatus extends TransactionStatus {
  readonly logs: readonly EvmParsedTransactionLog[] | null;
  readonly fees: EvmTransactionGasFees | null;

  constructor(init: EvmTransactionStatusInit) {
    super({
      chainId: init.chainId,
      status: init.status,
      inclusionAt: init.inclusionAt,
      error: init.error,
      balanceChanges: init.balanceChanges,
    });
    this.logs = init.logs ?? null;
    this.fees = init.fees ?? null;
  }

  static successful(args: {
    chainId: number;
    inclusionAt: Date | null;
    balanceChanges: NestedBalanceChanges;
    logs: readonly EvmParsedTransactionLog[];
    fees: EvmTransactionGasFees;
  }): EvmTransactionStatus {
    return new EvmTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Success,
      inclusionAt: args.inclusionAt,
      balanceChanges: args.balanceChanges,
      logs: args.logs,
      fees: args.fees,
      error: null,
    });
  }

  static failed(args: {
    chainId: number;
    inclusionAt: Date | null;
    error: TransactionErrorInfo;
    fees: EvmTransactionGasFees;
  }): EvmTransactionStatus {
    return new EvmTransactionStatus({
      chainId: args.chainId,
      status: TransactionStatusTypes.Failed,
      inclusionAt: args.inclusionAt,
      error: args.error,
      balanceChanges: null,
      logs: null,
      fees: args.fees,
    });
  }

  static pending(chainId: number): EvmTransactionStatus {
    return new EvmTransactionStatus({
      chainId,
      status: TransactionStatusTypes.Pending,
      inclusionAt: null,
      error: null,
      balanceChanges: null,
      logs: null,
      fees: null,
    });
  }

  static notFound(chainId: number, error: TransactionErrorInfo | null): EvmTransactionStatus {
    return new EvmTransactionStatus({
      chainId,
      status: TransactionStatusTypes.NotFound,
      inclusionAt: null,
      error,
      balanceChanges: null,
      logs: null,
      fees: null,
    });
  }
}
