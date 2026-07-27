import { ChainError, ChainErrorKinds } from '../errors.ts';
import {
  NestedBalanceChanges,
  TransactionErrorInfo,
  TransactionStatus,
  TransactionStatusType,
  TransactionStatusTypes,
} from '../transaction_status.ts';

export interface EvmTransactionGasFeesInit {
  /**
   * The sender-set gas limit (`tx.gasLimit`). Nullable because the tx body
   * may be unavailable (pruned node, receipt-only fetch); passing
   * `gasLimitUsed` here as a fallback would fabricate a "100% utilization"
   * that consumers can't distinguish from a real observation.
   */
  gasLimit: bigint | null;
  gasLimitUsed: bigint;
  effectiveGasPrice: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /**
   * OP-stack L1 data fee (wei) — present on Optimism / Base / Unichain /
   * WorldChain / Boba / Sonic and other L2s that publish tx data to L1.
   * Omitted on L1 chains. Included in the sender's native debit computed
   * by `decodeBalanceChanges` when populated.
   */
  l1FeeWei?: bigint;
}

export class EvmTransactionGasFees {
  readonly gasLimit: bigint | null;
  readonly gasLimitUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly gasPrice: bigint | undefined;
  readonly maxFeePerGas: bigint | undefined;
  readonly maxPriorityFeePerGas: bigint | undefined;
  readonly l1FeeWei: bigint | undefined;

  constructor(init: EvmTransactionGasFeesInit) {
    // Observed on-chain values (not caller inputs) — reject negatives only.
    // Zero-gas / subsidised environments and pruned-node receipts return 0
    // for one or more of these fields; throwing there would turn
    // getTransactionStatus from "returns a status" into "throws".
    if (init.gasLimit !== null && init.gasLimit < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmTransactionGasFees.gasLimit must be >= 0 or null, got ${init.gasLimit}`,
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
    if (init.l1FeeWei !== undefined && init.l1FeeWei < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `EvmTransactionGasFees.l1FeeWei must be >= 0, got ${init.l1FeeWei}`,
      );
    }
    this.gasLimit = init.gasLimit;
    this.gasLimitUsed = init.gasLimitUsed;
    this.effectiveGasPrice = init.effectiveGasPrice;
    this.gasPrice = init.gasPrice;
    this.maxFeePerGas = init.maxFeePerGas;
    this.maxPriorityFeePerGas = init.maxPriorityFeePerGas;
    this.l1FeeWei = init.l1FeeWei;
  }

  /** L2 execution gas only. Does NOT include OP-stack `l1FeeWei`. */
  get totalGasInWei(): bigint {
    return this.gasLimitUsed * this.effectiveGasPrice;
  }

  /** Full sender native debit: L2 gas + OP-stack L1 data fee (when present). */
  get totalNativeDebitWei(): bigint {
    return this.totalGasInWei + (this.l1FeeWei ?? 0n);
  }
}

/**
 * Canonical ERC-20 `Transfer(address indexed from, address indexed to,
 * uint256 value)` topic0 — keccak256("Transfer(address,address,uint256)").
 */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface EvmErc20TransferLog {
  tokenContract: string;
  fromAddress: string;
  toAddress: string;
  value: bigint;
}

/**
 * Event log entry surfaced on a receipt. `isTransferLog()` / `asTransferLog()`
 * mirror Python's `EvmParsedTransactionLog` API (`impl/evm/base.py:1551+`).
 *
 * The `evm_chain.ts` receipt-decoder shares the `ERC20_TRANSFER_TOPIC`
 * topic0 constant with this class but runs its own **lenient** parse
 * (skips non-standard logs) for the `NestedBalanceChanges` construction.
 * This class's `asTransferLog()` is **strict** (throws on wrong length /
 * bad hex). Rewiring the decoder to consume the strict accessor requires
 * a policy decision on whether non-standard logs should silently drop
 * or surface as `TransactionDecodeFailed`, and is deferred to a
 * follow-up card. Consumers doing their own log extraction should
 * either use the guard/accessor pair with a `try/catch` per log or
 * wait for a `tryAsTransferLog()` variant to land.
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

  isTransferLog(): boolean {
    return this.topics.length === 3 && this.topics[0].toLowerCase() === ERC20_TRANSFER_TOPIC;
  }

  /**
   * Decode this log as an ERC-20 Transfer. Throws
   * `ChainError(InvalidArgument)` if the log doesn't match the topic0
   * / topic-count shape, or `ChainError(TransactionDecodeFailed)` if
   * `data` isn't parseable as a `uint256`. Addresses are returned
   * lowercased (matches the `balanceChanges` wallet-key convention;
   * consumers who need EIP-55 should checksum via `EvmAddress`).
   */
  asTransferLog(): EvmErc20TransferLog {
    if (!this.isTransferLog()) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Log is not an ERC-20 Transfer (topics=${this.topics.length}, topic0=${this.topics[0] ?? ''})`,
      );
    }
    const topic1 = this.topics[1];
    const topic2 = this.topics[2];
    // 32-byte hex-encoded topics: exactly `0x` + 64 hex chars = 66 total.
    // Anything else is either truncated (would `slice(26)` a wrong window)
    // or padded (should not have reached a Transfer topic slot).
    if (!/^0x[0-9a-fA-F]{64}$/.test(topic1) || !/^0x[0-9a-fA-F]{64}$/.test(topic2)) {
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        `Transfer log topics malformed (topic1=${topic1}, topic2=${topic2})`,
      );
    }
    // ERC-20 Transfer data is exactly one uint256 = 32 bytes = 66-char hex.
    // Empty string, short data, or blobs longer than 32 bytes all reach
    // the decoder in the wild via non-standard tokens; fail loudly.
    if (!/^0x[0-9a-fA-F]{64}$/.test(this.data)) {
      throw new ChainError(
        ChainErrorKinds.TransactionDecodeFailed,
        `Transfer log data must be exactly 32 hex bytes, got '${this.data}'`,
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
        err instanceof Error ? err : undefined,
      );
    }
    return {
      tokenContract: this.address.toLowerCase(),
      fromAddress: `0x${topic1.slice(26)}`.toLowerCase(),
      toAddress: `0x${topic2.slice(26)}`.toLowerCase(),
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
