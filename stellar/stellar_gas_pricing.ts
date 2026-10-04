import { AbstractGasPricing } from '../abstract_gas_pricing.ts';
import { ChainType } from '../chain_type.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType } from '../network_type.ts';

export const STELLAR_MIN_BASE_FEE_STROOPS = 100;

export class StellarGasPricing extends AbstractGasPricing {
  static readonly chainType = ChainType.STELLAR;
  readonly networkType = NetworkType.STELLAR;
  readonly baseFeeStroops: number;

  constructor(init: { baseFeeStroops: number }) {
    super();
    if (!Number.isSafeInteger(init.baseFeeStroops)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `StellarGasPricing.baseFeeStroops must be an integer, got ${init.baseFeeStroops}`,
      );
    }
    this.baseFeeStroops = init.baseFeeStroops;
  }
}
