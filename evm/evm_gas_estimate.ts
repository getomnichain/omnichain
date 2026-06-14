export interface EvmGasEstimateInit {
  units?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export class EvmGasEstimate {
  readonly units?: bigint;
  readonly gasPrice?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;

  constructor(init: EvmGasEstimateInit) {
    this.units = init.units;
    this.gasPrice = init.gasPrice;
    this.maxFeePerGas = init.maxFeePerGas;
    this.maxPriorityFeePerGas = init.maxPriorityFeePerGas;
  }

  effectiveGasPrice(): bigint | undefined {
    return this.gasPrice ?? this.maxFeePerGas;
  }

  nativeCost(): bigint | undefined {
    const price = this.effectiveGasPrice();
    if (price === undefined || this.units === undefined) return undefined;
    return this.units * price;
  }
}
