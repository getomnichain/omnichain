import { NetworkType } from '../../network_type.ts';

import { EvmAddress } from '../../evm/evm_address.ts';
import { TonAddress } from '../ton_address.ts';

const VALID_TON_RAW =
  '-1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const VALID_TON_USER_FRIENDLY = 'EQDrjaLahLkMB-hMCmkzOyBuHJ139ZUYmPHu6RRBKnbdLIYI';

describe('TonAddress', () => {
  it('accepts raw workchain:hex form and preserves it', () => {
    const address = new TonAddress(VALID_TON_RAW);
    expect(address.canonical()).toBe(VALID_TON_RAW);
  });

  it('accepts user-friendly base64url form', () => {
    expect(() => new TonAddress(VALID_TON_USER_FRIENDLY)).not.toThrow();
  });

  it('reports TON network type', () => {
    expect(new TonAddress(VALID_TON_RAW).networkType).toBe(NetworkType.TON);
  });

  it('rejects short strings', () => {
    expect(() => new TonAddress('EQabc')).toThrow();
  });

  it('rejects a user-friendly address with a broken CRC checksum', () => {
    const broken = `${VALID_TON_USER_FRIENDLY.slice(0, 46)}AA`;
    expect(() => new TonAddress(broken)).toThrow(/checksum/i);
  });

  it('does not consider an EVM and a TON value equal even when strings match', () => {
    const evm = new EvmAddress('0xabcdef0123456789abcdef0123456789abcdef01');
    const ton = new TonAddress(VALID_TON_RAW);
    expect(evm.equals(ton)).toBe(false);
  });
});
