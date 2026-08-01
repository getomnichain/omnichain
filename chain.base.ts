import { Decimal } from 'decimal.js';

import { GasPricingType } from './abstract_gas_pricing.ts';
import { ChainError, ChainErrorKinds } from './errors.ts';
import { NetworkType } from './network_type.ts';
import { hrDecimalToMinorUnits } from './transaction_status.ts';

import { Token } from './token.ts';
import { TransactionStatus } from './transaction_status.ts';
import { UnsignedTransaction } from './unsigned_transaction.ts';

/**
 * Amount contract — Python parity with `create_transfer_transaction`
 * (base/base.py:529-539) which takes `amount_hr: Decimal` +
 * `is_full_balance: bool`. TS accepts either:
 *
 *   - `amount: bigint` — minor units (existing SDK-native form)
 *   - `amountHr: Decimal` — human-readable (Python-native form)
 *   - `isFullBalance: true` — sweep the sender's whole balance
 *
 * Exactly one of the three must be supplied. `resolveTransferAmount`
 * enforces this and throws `ChainError(InvalidArgument)` on ambiguous
 * input.
 */
export interface CreateTransferRequest {
  from?: string;
  to: string;
  tokenIdentifier?: string;
  amount?: bigint;
  amountHr?: Decimal;
  isFullBalance?: boolean;
  /**
   * Gas-pricing knob — Python's `gas_pricing: GasPricingType`. The type
   * surface is in place (Python parity) but per-chain builders **do
   * not consume it yet** in Wave 2B — passing ANY value (including
   * `FeePriority.NORMAL`) throws `ChainError(InvalidArgument)`. Wiring
   * to each chain's `suggestGas` / `suggestPriorityFeeMicroLamports` /
   * `suggestFeeRate` estimator lands in a follow-up card. Until then
   * use the existing per-chain option fields (Solana:
   * `priorityFeeMicroLamportsPerCu` / `computeUnitLimit`; UTXO:
   * `feeRateSatsPerVByte` / `feeTargetBlocks`; EVM: `UnsignedEvmTransaction`
   * builder options).
   */
  gasPricing?: GasPricingType;
  memo?: string;
  addressLookupTables?: unknown[];
}

export interface Eip7702Authorization {
  chainId: number;
  delegate: string;
  nonce: bigint;
  signature: { r: string; s: string; yParity: 0 | 1 };
}

export interface CreateUnsignedTransactionRequest {
  from: string;
  signal?: AbortSignal;
}

export interface BroadcastOpts {
  signal?: AbortSignal;
}

export interface GetTransactionStatusOpts {
  wait?: boolean;
  timeoutMs?: number;
  confirmations?: number;
  signal?: AbortSignal;
}

export type ResolvedTransferAmount =
  | { kind: 'exact'; amountMr: bigint }
  | { kind: 'full' };

/**
 * Validates that exactly one of `{amount, amountHr, isFullBalance}` was
 * supplied and normalizes to a common shape the chain builders consume.
 * Chain-agnostic — the caller supplies `decimals` (from the resolved
 * token). Rounds `amountHr` via `Decimal.trunc()` matching Python's
 * `hr_to_mr`.
 *
 * Non-integer decimals / negative amount / etc. throw
 * `ChainError(InvalidArgument)`.
 */
export function resolveTransferAmount(
  req: CreateTransferRequest,
  decimals: number,
): ResolvedTransferAmount {
  // Upfront typeof gate for isFullBalance — silently coercing a non-boolean
  // to "unset" here would let `{amount, isFullBalance: 'true'}` (JSON boundary
  // realistic) take the amount branch instead of failing the exactly-one-of.
  if (req.isFullBalance !== undefined && typeof req.isFullBalance !== 'boolean') {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `CreateTransferRequest.isFullBalance must be a boolean (got ${typeof req.isFullBalance})`,
    );
  }
  const provided: string[] = [];
  if (req.amount !== undefined) provided.push('amount');
  if (req.amountHr !== undefined) provided.push('amountHr');
  if (req.isFullBalance === true) provided.push('isFullBalance');
  if (provided.length === 0) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      'CreateTransferRequest: one of {amount, amountHr, isFullBalance} is required',
    );
  }
  if (provided.length > 1) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `CreateTransferRequest: exactly one of {amount, amountHr, isFullBalance} may be set (got ${provided.join(', ')})`,
    );
  }
  if (req.isFullBalance === true) return { kind: 'full' };
  if (req.amount !== undefined) {
    // Explicit typeof check: JS mixed-type comparison lets '1000000' <= 0n
    // return false (`StringToBigInt`), so a string/number amount would
    // otherwise pass this guard and land verbatim in tx.value /
    // lamports / ERC-20 calldata. Realistic vector: consumers
    // deserializing amounts from HTTP/DB JSON.
    if (typeof req.amount !== 'bigint') {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `CreateTransferRequest.amount must be a bigint (got ${typeof req.amount})`,
      );
    }
    if (req.amount <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `CreateTransferRequest.amount must be > 0, got ${req.amount}`,
      );
    }
    return { kind: 'exact', amountMr: req.amount };
  }
  // amountHr branch. Cross-copy-safe structural probe: `instanceof
  // Decimal` and `Decimal.isDecimal` both key off constructor identity
  // in practice (isDecimal's toStringTag branch is dead against the
  // shipped prototype), so a `Decimal` from a nested/duplicated copy of
  // decimal.js in the consumer tree would falsely reject. Instead:
  // probe for the two methods we actually need (`toFixed`, `isFinite`),
  // then normalize via `Decimal.prototype.toString` — an exact,
  // always-reparseable serialization — into our own Decimal instance.
  const rawHr = req.amountHr as unknown;
  if (
    rawHr === null ||
    typeof rawHr !== 'object' ||
    typeof (rawHr as { toFixed?: unknown }).toFixed !== 'function' ||
    typeof (rawHr as { isFinite?: unknown }).isFinite !== 'function' ||
    typeof (rawHr as { toString?: unknown }).toString !== 'function'
  ) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      'CreateTransferRequest.amountHr must be a Decimal value (structural probe: needs toFixed + isFinite + toString)',
    );
  }
  let hr: Decimal;
  try {
    hr = new Decimal((rawHr as { toString: () => string }).toString());
  } catch (err) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      'CreateTransferRequest.amountHr: string round-trip failed',
      undefined,
      err instanceof Error ? err : undefined,
    );
  }
  if (!hr.isFinite()) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `CreateTransferRequest.amountHr must be finite, got ${hr.toString()}`,
    );
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `CreateTransferRequest.amountHr requires a non-negative integer decimals, got ${decimals}`,
    );
  }
  if (hr.isNegative()) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `CreateTransferRequest.amountHr must be >= 0, got ${hr.toString()}`,
    );
  }
  // Exact conversion via string-shift (bypasses decimal.js's 20-sig-digit
  // precision limit that would silently round the last wei on 18-decimal
  // amounts ≥ ~100 tokens).
  const amountMr = hrDecimalToMinorUnits(hr, decimals);
  if (amountMr <= 0n) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `CreateTransferRequest.amountHr must convert to > 0 minor units, got ${amountMr} (from ${hr.toString()} @ ${decimals} decimals)`,
    );
  }
  return { kind: 'exact', amountMr };
}

export abstract class Chain {
  readonly chainId: number;
  readonly name: string;
  readonly networkType: NetworkType;
  readonly blockTimeSeconds: number;
  readonly nativeSymbol: string;
  readonly explorerBaseUrl: string;

  protected constructor(
    chainId: number,
    name: string,
    networkType: NetworkType,
    blockTimeSeconds: number,
    nativeSymbol: string,
    explorerBaseUrl: string
  ) {
    if (!Number.isInteger(chainId)) {
      throw new Error('Chain chainId must be an integer');
    }
    this.chainId = chainId;
    this.name = name;
    this.networkType = networkType;
    this.blockTimeSeconds = blockTimeSeconds;
    this.nativeSymbol = nativeSymbol;
    this.explorerBaseUrl = explorerBaseUrl.replace(/\/$/, '');
  }

  abstract get nativeToken(): Token;

  abstract getWalletExplorerUrl(address: string): string;
  abstract getTokenExplorerUrl(tokenIdentifier?: string): string;
  abstract getTransactionExplorerUrl(txHash: string): string;

  abstract validateAddress(raw: string): boolean;
  abstract validateTokenIdentifier(raw: string | undefined): boolean;

  abstract getBalance(owner: string, tokenIdentifier?: string): Promise<bigint>;

  abstract createTransferUnsignedTransaction(req: CreateTransferRequest): Promise<UnsignedTransaction>;

  abstract createUnsignedTransaction(req: CreateUnsignedTransactionRequest): Promise<UnsignedTransaction>;

  abstract broadcast(signed: string | Uint8Array, opts?: BroadcastOpts): Promise<string>;

  abstract getTransactionStatus(
    txHash: string | string[],
    opts?: GetTransactionStatusOpts,
  ): Promise<TransactionStatus | TransactionStatus[]>;

  abstract getChainTipHeight(): Promise<number>;

  toString(): string {
    return `Chain[chainId=${this.chainId}, name=${this.name}, networkType=${this.networkType}]`;
  }
}
