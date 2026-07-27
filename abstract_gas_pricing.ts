import { NetworkType } from './network_type.ts';
import { FeePriority } from './priority.ts';

/**
 * Base for chain-specific *explicit* fee overrides — mirrors Python's
 * `AbstractGasPricing(pydantic.BaseModel)` at `base/base.py:141-158`.
 * A subclass declares its `networkType` and carries the concrete fee
 * fields for that chain (`EvmGasPricing`, `SolanaGasPricing`,
 * `UtxoGasPricing`).
 *
 * A caller who wants exact numeric control passes an `AbstractGasPricing`
 * subclass to `createTransferUnsignedTransaction`; passing a
 * `FeePriority` tier (SLOW/NORMAL/FAST) instead defers to each chain's
 * `suggest*` estimator. See `GasPricingType`.
 */
export abstract class AbstractGasPricing {
  abstract readonly networkType: NetworkType;
}

/**
 * The gas-pricing argument accepted by every
 * `createTransferUnsignedTransaction`. Mirrors Python's
 * `GasPricingType = Union[FeePriority, AbstractGasPricing]` at
 * `base/base.py:162`. Consumers use `FeePriority.NORMAL` by default;
 * explicit overrides use a per-chain subclass.
 */
export type GasPricingType = FeePriority | AbstractGasPricing;

/**
 * Runtime discriminator for `GasPricingType`. `FeePriority` is a
 * string enum; `AbstractGasPricing` is a class instance.
 */
export function isAbstractGasPricing(value: GasPricingType): value is AbstractGasPricing {
  return value instanceof AbstractGasPricing;
}
