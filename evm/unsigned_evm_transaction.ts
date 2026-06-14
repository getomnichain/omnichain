import { NetworkType } from '../network_type.ts';

import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { EvmGasEstimate } from './evm_gas_estimate.ts';

export interface UnsignedEvmTransactionInit {
  chainId: number;
  to: string;
  value: bigint;
  data?: string;
  from?: string;
  gasEstimate?: EvmGasEstimate;
}

export class UnsignedEvmTransaction extends UnsignedTransaction {
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly from?: string;
  readonly gasEstimate?: EvmGasEstimate;

  constructor(init: UnsignedEvmTransactionInit) {
    super(init.chainId, NetworkType.EVM);
    this.to = init.to;
    this.value = init.value;
    this.data = init.data ?? '0x';
    this.from = init.from;
    this.gasEstimate = init.gasEstimate;
  }
}
