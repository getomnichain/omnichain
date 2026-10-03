import { Address } from '../address.ts';
import { NetworkType } from '../network_type.ts';
import { isValidStellarEd25519PublicKey, isValidStellarMed25519PublicKey } from './stellar_strkey.ts';

export class StellarAddress extends Address {
  constructor(raw: string) {
    super(raw);
    if (typeof raw !== 'string') {
      throw new Error('Invalid Stellar address: not a string');
    }
    if (!isValidStellarEd25519PublicKey(raw) && !isValidStellarMed25519PublicKey(raw)) {
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
