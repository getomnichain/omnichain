import { NetworkType } from './network_type.ts';

export abstract class UnsignedTransaction {
  readonly chainId: number;
  readonly networkType: NetworkType;

  protected constructor(chainId: number, networkType: NetworkType) {
    this.chainId = chainId;
    this.networkType = networkType;
  }
}
