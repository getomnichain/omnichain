import { AbstractGasPricing } from '../abstract_gas_pricing.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType } from '../network_type.ts';

export interface UtxoGasPricingInit {
  /**
   * Fee rate in satoshis per virtual byte. Bitcoin Core `estimatesmartfee`
   * returns BTC-per-kB; the SDK's `suggestFeeRate` already normalizes to
   * sat/vB, and `UtxoGasPricing` accepts the same unit for consumer
   * parity.
   */
  satsPerVByte: number;
}

/**
 * UTXO explicit-fee override — mirrors Python's `UtxoGasPricing` at
 * `impl/utxo/base.py`. Alternative to passing a `FeePriority` tier;
 * the tier is resolved via `suggestFeeRate`.
 */
export class UtxoGasPricing extends AbstractGasPricing {
  readonly networkType = NetworkType.BTC;
  readonly satsPerVByte: number;

  constructor(init: UtxoGasPricingInit) {
    super();
    if (!Number.isFinite(init.satsPerVByte) || init.satsPerVByte < 0) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `UtxoGasPricing.satsPerVByte must be a non-negative finite number, got ${init.satsPerVByte}`,
      );
    }
    this.satsPerVByte = init.satsPerVByte;
  }
}
