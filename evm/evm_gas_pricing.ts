import { AbstractGasPricing } from '../abstract_gas_pricing.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType } from '../network_type.ts';

export interface EvmLegacyGasPricingInit {
  kind: 'legacy';
  gasPrice: bigint;
}

export interface EvmEip1559GasPricingInit {
  kind: 'eip1559';
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export type EvmGasPricingInit = EvmLegacyGasPricingInit | EvmEip1559GasPricingInit;

/**
 * EVM explicit-fee override — mirrors Python's `EvmGasPricing` at
 * `impl/evm/base.py`. Discriminated by `kind` for the same reason
 * `EvmGasEstimate` is: consumers reading `.gasPrice` on a 1559 pricing
 * would otherwise silently get `undefined`.
 *
 * Legacy pricing populates `gasPrice`; EIP-1559 pricing populates
 * `maxFeePerGas` + `maxPriorityFeePerGas`. Cross-branch reads are
 * `undefined`.
 */
export class EvmGasPricing extends AbstractGasPricing {
  readonly networkType = NetworkType.EVM;
  readonly kind: 'legacy' | 'eip1559';
  readonly gasPrice: bigint | undefined;
  readonly maxFeePerGas: bigint | undefined;
  readonly maxPriorityFeePerGas: bigint | undefined;

  constructor(init: EvmGasPricingInit) {
    super();
    this.kind = init.kind;
    if (init.kind === 'legacy') {
      if (init.gasPrice < 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasPricing(legacy).gasPrice must be >= 0, got ${init.gasPrice}`,
        );
      }
      this.gasPrice = init.gasPrice;
      this.maxFeePerGas = undefined;
      this.maxPriorityFeePerGas = undefined;
    } else {
      if (init.maxFeePerGas < 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasPricing(eip1559).maxFeePerGas must be >= 0, got ${init.maxFeePerGas}`,
        );
      }
      if (init.maxPriorityFeePerGas < 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasPricing(eip1559).maxPriorityFeePerGas must be >= 0, got ${init.maxPriorityFeePerGas}`,
        );
      }
      // EIP-1559 invariant: maxPriorityFeePerGas must be <= maxFeePerGas.
      // Every execution client enforces this at admission (a tx that
      // violates it can never be mined). Fail loud at construction.
      if (init.maxPriorityFeePerGas > init.maxFeePerGas) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasPricing(eip1559): maxPriorityFeePerGas (${init.maxPriorityFeePerGas}) must be <= maxFeePerGas (${init.maxFeePerGas}) per EIP-1559`,
        );
      }
      this.gasPrice = undefined;
      this.maxFeePerGas = init.maxFeePerGas;
      this.maxPriorityFeePerGas = init.maxPriorityFeePerGas;
    }
  }
}

export function isLegacyGasPricing(
  p: EvmGasPricing,
): p is EvmGasPricing & { kind: 'legacy'; gasPrice: bigint } {
  return p.kind === 'legacy';
}

export function isEip1559GasPricing(
  p: EvmGasPricing,
): p is EvmGasPricing & {
  kind: 'eip1559';
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
} {
  return p.kind === 'eip1559';
}
