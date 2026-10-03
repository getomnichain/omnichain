import { Address } from '../address.ts';
import { NetworkType } from '../network_type.ts';
import { isBase58CheckAddress, toBase58CheckAddress } from './tron_keys.ts';

export class TronAddress extends Address {
  private readonly base58: string;

  constructor(raw: string) {
    super(raw);
    if (typeof raw !== 'string') {
      throw new Error('Invalid Tron address: not a string');
    }
    let canonical: string;
    try {
      canonical = toBase58CheckAddress(raw);
    } catch (err) {
      throw new Error(`Invalid Tron address: "${raw}": ${(err as Error).message}`);
    }
    if (!isBase58CheckAddress(canonical)) {
      throw new Error(`Invalid Tron address: "${raw}"`);
    }
    this.base58 = canonical;
  }

  canonical(): string {
    return this.base58;
  }

  get networkType(): NetworkType {
    return NetworkType.TRON;
  }
}
