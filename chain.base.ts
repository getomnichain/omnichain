import Decimal from 'decimal.js';

import { GasPricingType } from './abstract_gas_pricing.ts';
import { ChainError, ChainErrorKinds } from './errors.ts';
import { NetworkType } from './network_type.ts';
import { FeePriority } from './priority.ts';

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
   * Gas-pricing knob — Python's `gas_pricing: GasPricingType`. Defaults
   * to `FeePriority.NORMAL`. Pass a `FeePriority` tier (SLOW/NORMAL/FAST)
   * to defer to each chain's `suggest*` estimator, OR an
   * `AbstractGasPricing` subclass (`EvmGasPricing` / `SolanaGasPricing` /
   * `UtxoGasPricing`) for exact numeric control.
   */
  gasPricing?: GasPricingType;
  memo?: string;
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
    if (req.amount < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `CreateTransferRequest.amount must be >= 0, got ${req.amount}`,
      );
    }
    return { kind: 'exact', amountMr: req.amount };
  }
  // amountHr branch
  const hr = req.amountHr as Decimal;
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
  const shifted = hr.mul(new Decimal(10).pow(decimals)).trunc();
  return { kind: 'exact', amountMr: BigInt(shifted.toFixed(0)) };
}

/** Default gas pricing when the consumer doesn't pass one. */
export const DEFAULT_GAS_PRICING: FeePriority = FeePriority.NORMAL;

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

  abstract getTransactionStatus(txHash: string): Promise<TransactionStatus>;

  abstract getChainTipHeight(): Promise<number>;

  toString(): string {
    return `Chain[chainId=${this.chainId}, name=${this.name}, networkType=${this.networkType}]`;
  }
}
