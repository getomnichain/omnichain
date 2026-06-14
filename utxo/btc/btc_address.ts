import { address as bjsAddress } from 'bitcoinjs-lib';

import { Address } from '../../address.ts';
import { NetworkType } from '../../network_type.ts';

import '../ecc.ts';
import { UtxoScriptType, detectScriptType } from '../script.ts';
import { BtcNetworkParams } from './network_params.ts';

export class BtcAddress extends Address {
  readonly params: BtcNetworkParams;
  readonly scriptType: UtxoScriptType;

  constructor(raw: string, params: BtcNetworkParams) {
    super(raw);
    this.params = params;
    const script = BtcAddress.assertValid(raw, params);
    this.scriptType = detectScriptType(script);
  }

  canonical(): string {
    return this.raw;
  }

  get networkType(): NetworkType {
    return NetworkType.BTC;
  }

  scriptPubKey(): Uint8Array {
    return bjsAddress.toOutputScript(this.raw, this.params.networkInfo);
  }

  private static assertValid(raw: string, params: BtcNetworkParams): Uint8Array {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error('BtcAddress: address must be a non-empty string');
    }
    if (!params.walletAddressRegex.test(raw)) {
      throw new Error(`BtcAddress: "${raw}" does not match ${params.name} address format`);
    }
    try {
      return bjsAddress.toOutputScript(raw, params.networkInfo);
    } catch (err) {
      throw new Error(
        `BtcAddress: "${raw}" failed checksum/decode for ${params.name}: ${(err as Error).message}`
      );
    }
  }
}
