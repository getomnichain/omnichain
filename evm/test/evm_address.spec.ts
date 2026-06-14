import { EvmAddress } from '../evm_address.ts';

const VALID_EIP55 = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const VALID_LOWERCASE = VALID_EIP55.toLowerCase();
const VALID_UPPERCASE = '0x' + VALID_EIP55.slice(2).toUpperCase();
const BAD_CHECKSUM = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('EvmAddress', () => {
  it('accepts EIP-55 mixed-case checksum', () => {
    const addr = new EvmAddress(VALID_EIP55);
    expect(addr.canonical()).toBe(VALID_LOWERCASE);
  });

  it('accepts all-lowercase', () => {
    const addr = new EvmAddress(VALID_LOWERCASE);
    expect(addr.canonical()).toBe(VALID_LOWERCASE);
  });

  it('accepts all-uppercase body', () => {
    const addr = new EvmAddress(VALID_UPPERCASE);
    expect(addr.canonical()).toBe(VALID_LOWERCASE);
  });

  it('rejects bad mixed-case checksum', () => {
    expect(() => new EvmAddress(BAD_CHECKSUM)).toThrow(/checksum/i);
  });

  it('rejects wrong length and non-hex', () => {
    expect(() => new EvmAddress('0x123')).toThrow();
    expect(() => new EvmAddress('not-an-address')).toThrow();
  });

  it('prepends 0x if missing', () => {
    const addr = new EvmAddress(VALID_EIP55.slice(2));
    expect(addr.canonical()).toBe(VALID_LOWERCASE);
  });

  it('toChecksum() produces EIP-55 form', () => {
    const addr = new EvmAddress(VALID_LOWERCASE);
    expect(addr.toChecksum()).toBe(VALID_EIP55);
  });
});
