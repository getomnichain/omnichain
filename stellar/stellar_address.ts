import { StrKey } from '@stellar/stellar-sdk';

import { Address } from '../address.ts';
import { NetworkType } from '../network_type.ts';

export class StellarAddress extends Address {
  constructor(raw: string) {
    super(raw);
    if (typeof raw !== 'string') {
      throw new Error('Invalid Stellar address: not a string');
    }
    if (!StrKey.isValidEd25519PublicKey(raw) && !StrKey.isValidMed25519PublicKey(raw)) {
      throw new Error(`Invalid Stellar wallet address "${raw}"`);
    }
  }

  canonical(): string {
    return this.raw;
  }

  get networkType(): NetworkType {
    return NetworkType.STELLAR;
  }
}
