import { Address } from '../address.ts';
import { NetworkType } from '../network_type.ts';
import { TRON_ADDRESS_PREFIX_BYTE, b58decodeCheck } from './tron_base58.ts';

const TRON_BASE58_ADDRESS_LENGTH = 34;
const TRON_RAW_ADDRESS_LENGTH = 21;

export class TronAddress extends Address {
  constructor(raw: string) {
    super(raw);
    if (typeof raw !== 'string') {
      throw new Error('Invalid Tron address: not a string');
    }
    if (!TronAddress.isCanonical(raw)) {
      throw new Error(`Invalid Tron address: "${raw}"`);
    }
  }

  canonical(): string {
    return this.raw;
  }

  get networkType(): NetworkType {
    return NetworkType.TRON;
  }

  private static isCanonical(raw: string): boolean {
    if (raw.length !== TRON_BASE58_ADDRESS_LENGTH || raw[0] !== 'T') return false;
    try {
      const payload = b58decodeCheck(raw);
      return payload.length === TRON_RAW_ADDRESS_LENGTH && payload[0] === TRON_ADDRESS_PREFIX_BYTE;
    } catch {
      return false;
    }
  }
}
