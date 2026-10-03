import { AbstractGasPricing } from '../abstract_gas_pricing.ts';
import { ChainType } from '../chain_type.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType } from '../network_type.ts';

export class TronGasPricing extends AbstractGasPricing {
  static readonly chainType = ChainType.TRON;
  readonly networkType = NetworkType.TRON;
  readonly feeLimitSun: number;

  constructor(init: { feeLimitSun: number }) {
    super();
    if (!Number.isSafeInteger(init.feeLimitSun)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `TronGasPricing.feeLimitSun must be an integer, got ${init.feeLimitSun}`,
      );
    }
    this.feeLimitSun = init.feeLimitSun;
  }
}
