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
 * Type-guards: `isLegacyGasEstimate(g)` and `isEip1559GasEstimate(g)`
 * narrow the estimate to its concrete shape at the call site.
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
      // Accept 0 for subsidised chains / devnets that report a zero
      // gas price. EvmChain.suggestGas feeds node-reported values in
      // directly; throwing here would turn a read-only estimate into
      // an exception on any zero-fee network. Symmetric with
      // EvmTransactionGasFees, which accepts 0 for the same fields.
      if (init.gasPrice < 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasEstimate(legacy).gasPrice must be >= 0, got ${init.gasPrice}`,
        );
      }
      this.gasPrice = init.gasPrice;
      this.maxFeePerGas = undefined;
      this.maxPriorityFeePerGas = undefined;
    } else {
      if (init.maxFeePerGas < 0n) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `EvmGasEstimate(eip1559).maxFeePerGas must be >= 0, got ${init.maxFeePerGas}`,
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
    // Discriminant narrowing — no cast needed. The constructor sets exactly
    // one side of the shape based on `kind`, and the >= 0 validators
    // guarantee both are bigints (never undefined) within their branch.
    if (isLegacyGasEstimate(this)) return this.gasPrice;
    if (isEip1559GasEstimate(this)) return this.maxFeePerGas;
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `EvmGasEstimate: unknown kind '${String((this as { kind: string }).kind)}'`,
    );
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
