import { AbstractGasPricing } from '../abstract_gas_pricing.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType } from '../network_type.ts';

export interface SolanaGasPricingInit {
  /**
   * Priority fee per compute unit, in micro-lamports. Passed to the
   * `ComputeBudgetProgram.setComputeUnitPrice` instruction so the leader
   * reorders the tx above lower-priced traffic. `0n` means "no bid" —
   * the tx pays only the base fee.
   */
  priorityFeeMicroLamports: bigint;
  /**
   * Optional explicit compute-unit limit. When omitted, the transfer
   * builder uses the chain's default (usually 200_000 for a native SOL
   * transfer + 400_000 for SPL transfers with ATA creation).
   */
  computeUnitLimit?: bigint;
}

/**
 * Solana explicit-fee override — mirrors Python's `SolanaGasPricing` at
 * `impl/solana/base.py`. Alternative to passing a `FeePriority` tier to
 * `createTransferUnsignedTransaction`; the tier is resolved via
 * `suggestPriorityFeeMicroLamports`.
 */
export class SolanaGasPricing extends AbstractGasPricing {
  readonly networkType = NetworkType.SOLANA;
  readonly priorityFeeMicroLamports: bigint;
  readonly computeUnitLimit: bigint | undefined;

  constructor(init: SolanaGasPricingInit) {
    super();
    if (init.priorityFeeMicroLamports < 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `SolanaGasPricing.priorityFeeMicroLamports must be >= 0, got ${init.priorityFeeMicroLamports}`,
      );
    }
    if (init.computeUnitLimit !== undefined && init.computeUnitLimit <= 0n) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `SolanaGasPricing.computeUnitLimit must be > 0 or undefined, got ${init.computeUnitLimit}`,
      );
    }
    this.priorityFeeMicroLamports = init.priorityFeeMicroLamports;
    this.computeUnitLimit = init.computeUnitLimit;
  }
}
