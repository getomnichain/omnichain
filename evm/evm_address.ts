import jsSha3 from 'js-sha3';

import { NetworkType } from '../network_type.ts';

import { Address } from '../address.ts';

const { keccak_256 } = jsSha3;

const EVM_ADDRESS_BODY_REGEX = /^[a-fA-F0-9]{40}$/;

export class EvmAddress extends Address {
  constructor(raw: string) {
    super(EvmAddress.normalize(raw));
    EvmAddress.assertChecksumIfMixedCase(this.raw);
  }

  canonical(): string {
    return this.raw.toLowerCase();
  }

  toChecksum(): string {
    const body = this.canonical().slice(2);
    const hash = keccak_256(body);
    let result = '0x';
    for (let index = 0; index < body.length; index++) {
      const nibble = parseInt(hash[index], 16);
      result += nibble >= 8 ? body[index].toUpperCase() : body[index];
    }
    return result;
  }

  get networkType(): NetworkType {
    return NetworkType.EVM;
  }

  private static normalize(raw: string): string {
    if (typeof raw !== 'string') {
      throw new Error(`Invalid EVM address: not a string`);
    }
    const withPrefix = raw.startsWith('0x') || raw.startsWith('0X') ? raw : `0x${raw}`;
    const body = withPrefix.slice(2);
    if (!EVM_ADDRESS_BODY_REGEX.test(body)) {
      throw new Error(`Invalid EVM address: "${raw}"`);
    }
    return `0x${body}`;
  }

  private static assertChecksumIfMixedCase(prefixed: string): void {
    const body = prefixed.slice(2);
    const isAllLower = body === body.toLowerCase();
    const isAllUpper = body === body.toUpperCase();
    if (isAllLower || isAllUpper) return;

    const hash = keccak_256(body.toLowerCase());
    for (let index = 0; index < body.length; index++) {
      const nibble = parseInt(hash[index], 16);
      const expectedUpper = nibble >= 8;
      const actualIsUpper = body[index] >= 'A' && body[index] <= 'F';
      const actualIsAlpha = actualIsUpper || (body[index] >= 'a' && body[index] <= 'f');
      if (actualIsAlpha && actualIsUpper !== expectedUpper) {
        throw new Error(`Invalid EVM address checksum: "${prefixed}"`);
      }
    }
  }
}
