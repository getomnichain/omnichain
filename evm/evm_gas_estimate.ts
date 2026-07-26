import { ChainError, ChainErrorKinds } from '../errors.ts';

export type EvmGasEstimateKind = 'legacy' | 'eip1559';

export interface EvmLegacyGasEstimateInit {
  kind: 'legacy';
  units?: bigint;
  gasPrice: bigint;
}

export interface EvmEip1559GasEstimateInit {
  kind: 'eip1559';
  units?: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export type EvmGasEstimateInit = EvmLegacyGasEstimateInit | EvmEip1559GasEstimateInit;

/**
 * Discriminated `EvmGasEstimate` — the `kind` field tells consumers which fee
 * fields are populated. Iter-15 medium #4 fix: without the discriminant the
 * legacy path returned `{gasPrice}` only and 1559 returned
 * `{maxFeePerGas, maxPriorityFeePerGas}` only, but the type made both
 * shapes look interchangeable. Consumers touching an undefined field on
 * the wrong branch got runtime `undefined` with a non-null assertion
 * silencing the type system.
 *
 * Type-guards: `isLegacy(g)` and `isEip1559(g)` narrow the estimate to
 * its concrete shape at the call site.
 */
export class EvmGasEstimate {
  readonly kind: EvmGasEstimateKind;
  readonly units: bigint | undefined;
  readonly gasPrice: bigint | undefined;
  readonly maxFeePerGas: bigint | undefined;
  readonly maxPriorityFeePerGas: bigint | undefined;

  constructor(init: EvmGasEstimateInit) {
    this.kind = init.kind;
    this.units = init.units;
    if (init.kind === 'legacy') {
      if (init.gasPrice <= 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasEstimate(legacy).gasPrice must be > 0, got ${init.gasPrice}`,
        );
      }
      this.gasPrice = init.gasPrice;
      this.maxFeePerGas = undefined;
      this.maxPriorityFeePerGas = undefined;
    } else {
      if (init.maxFeePerGas <= 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasEstimate(eip1559).maxFeePerGas must be > 0, got ${init.maxFeePerGas}`,
        );
      }
      if (init.maxPriorityFeePerGas < 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasEstimate(eip1559).maxPriorityFeePerGas must be >= 0, got ${init.maxPriorityFeePerGas}`,
        );
      }
      this.gasPrice = undefined;
      this.maxFeePerGas = init.maxFeePerGas;
      this.maxPriorityFeePerGas = init.maxPriorityFeePerGas;
    }
  }

  effectiveGasPrice(): bigint {
    return this.kind === 'legacy' ? (this.gasPrice as bigint) : (this.maxFeePerGas as bigint);
  }

  nativeCost(): bigint | undefined {
    if (this.units === undefined) return undefined;
    return this.units * this.effectiveGasPrice();
  }
}

export function isLegacyGasEstimate(
  g: EvmGasEstimate,
): g is EvmGasEstimate & { kind: 'legacy'; gasPrice: bigint } {
  return g.kind === 'legacy';
}

export function isEip1559GasEstimate(
  g: EvmGasEstimate,
): g is EvmGasEstimate & { kind: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  return g.kind === 'eip1559';
}
