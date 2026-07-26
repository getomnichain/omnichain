import { ChainError, ChainErrorKinds } from '../errors.ts';
import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
    if (init.gasLimit <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmTransactionGasFees.gasLimit must be > 0, got ${init.gasLimit}`,
      );
    }
    if (init.gasLimitUsed <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmTransactionGasFees.gasLimitUsed must be > 0, got ${init.gasLimitUsed}`,
      );
    }
    if (init.effectiveGasPrice <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmTransactionGasFees.effectiveGasPrice must be > 0, got ${init.effectiveGasPrice}`,
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

export interface EvmErc20TransferLog {
  tokenContract: string;
  fromAddress: string;
  toAddress: string;
  value: bigint;
}

export class EvmParsedTransactionLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;

  constructor(address: string, topics: readonly string[], data: string) {
    this.address = address;
    this.topics = topics;
    this.data = data;
  }

  isTransferLog(): boolean {
    return this.topics.length === 3 && this.topics[0].toLowerCase() === ERC20_TRANSFER_TOPIC;
  }

  asTransferLog(): EvmErc20TransferLog {
    if (!this.isTransferLog()) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Log is not an ERC-20 Transfer (topics=${this.topics.length}, topic0=${this.topics[0] ?? ''})`,
      );
    }
    let value: bigint;
    try {
      value = BigInt(this.data);
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        `Failed to parse Transfer log data as bigint: ${this.data}`,
        undefined,
        err,
      );
    }
    return {
      tokenContract: this.address,
      fromAddress: `0x${this.topics[1].slice(26)}`,
      toAddress: `0x${this.topics[2].slice(26)}`,
      value,
    };
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
    inclusionAt: Date;
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
    inclusionAt: Date;
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
