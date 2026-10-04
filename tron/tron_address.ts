import { Address } from '../address.ts';
import { NetworkType } from '../network_type.ts';
import { isBase58CheckAddress, toBase58CheckAddress } from './tron_base58.ts';

export class TronAddress extends Address {
  private readonly base58: string;

  constructor(raw: string) {
    super(raw);
    if (typeof raw !== 'string') {
      throw new Error('Invalid Tron address: not a string');
    }
    const canonical = TronAddress.validatedBase58(raw);
    if (canonical === null) {
      throw new Error(`Invalid Tron address: "${raw}"`);
    }
    this.base58 = canonical;
  }

  static validatedBase58(raw: string): string | null {
    if (!isBase58CheckAddress(raw)) return null;
    try {
      return toBase58CheckAddress(raw);
    } catch {
      return null;
    }
  }

  canonical(): string {
    return this.base58;
  }

  get networkType(): NetworkType {
    return NetworkType.TRON;
  }
}
