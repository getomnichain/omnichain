import { Psbt } from 'bitcoinjs-lib';

import { NetworkType } from '../network_type.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';

import { UnspentTransactionOutput } from './utxo.ts';
import { UtxoNetworkParams } from './utxo_network_params.ts';

export interface UnsignedUtxoTransactionInit {
  chainId: number;
  params: UtxoNetworkParams;
  psbtBase64: string;
  selectedInputs: readonly UnspentTransactionOutput[];
  feeSats: number;
  feeRateSatsPerVByte: number;
  estimatedVBytes: number;
  totalInputSats: number;
  totalOutputSats: number;
  changeAddress: string | null;
  inputsToSign: Record<string, number[]>;
}

export class UnsignedUtxoTransaction extends UnsignedTransaction {
  readonly params: UtxoNetworkParams;
  readonly psbtBase64: string;
  readonly selectedInputs: readonly UnspentTransactionOutput[];
  readonly feeSats: number;
  readonly feeRateSatsPerVByte: number;
  readonly estimatedVBytes: number;
  readonly totalInputSats: number;
  readonly totalOutputSats: number;
  readonly changeAddress: string | null;
  readonly inputsToSign: Readonly<Record<string, number[]>>;

  constructor(init: UnsignedUtxoTransactionInit) {
    super(init.chainId, NetworkType.BTC);
    this.params = init.params;
    this.psbtBase64 = init.psbtBase64;
    this.selectedInputs = init.selectedInputs;
    this.feeSats = init.feeSats;
    this.feeRateSatsPerVByte = init.feeRateSatsPerVByte;
    this.estimatedVBytes = init.estimatedVBytes;
    this.totalInputSats = init.totalInputSats;
    this.totalOutputSats = init.totalOutputSats;
    this.changeAddress = init.changeAddress;
    this.inputsToSign = init.inputsToSign;
  }

  toPsbt(): Psbt {
    return Psbt.fromBase64(this.psbtBase64, { network: this.params.networkInfo });
  }
}
