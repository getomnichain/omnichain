import { Eip7702Authorization } from '../chain.base.ts';
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
  type?: 0 | 2 | 4;
  authorizationList?: Eip7702Authorization[];
  gasLimit?: bigint;
  nonce?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export class UnsignedEvmTransaction extends UnsignedTransaction {
  readonly to: string;
  readonly value: bigint;
  readonly data: string;
  readonly from?: string;
  readonly gasEstimate?: EvmGasEstimate;
  readonly type?: 0 | 2 | 4;
  readonly authorizationList?: Eip7702Authorization[];
  readonly gasLimit?: bigint;
  readonly nonce?: bigint;
  readonly maxFeePerGas?: bigint;
  readonly maxPriorityFeePerGas?: bigint;

  constructor(init: UnsignedEvmTransactionInit) {
    super(init.chainId, NetworkType.EVM);
    this.to = init.to;
    this.value = init.value;
    this.data = init.data ?? '0x';
    this.from = init.from;
    this.gasEstimate = init.gasEstimate;
    this.type = init.type;
    this.authorizationList = init.authorizationList;
    this.gasLimit = init.gasLimit;
    this.nonce = init.nonce;
    this.maxFeePerGas = init.maxFeePerGas;
    this.maxPriorityFeePerGas = init.maxPriorityFeePerGas;
  }
}
