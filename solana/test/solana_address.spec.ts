import { SolanaAddress } from '../solana_address.ts';

const VALID = 'So11111111111111111111111111111111111111112'; // wrapped SOL mint (32-byte base58)
const VALID_RANDOM = '5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4';

describe('SolanaAddress', () => {
  it('parses well-known base58 addresses', () => {
    expect(new SolanaAddress(VALID).canonical()).toBe(VALID);
    expect(new SolanaAddress(VALID_RANDOM).canonical()).toBe(VALID_RANDOM);
  });

  it('trims surrounding whitespace', () => {
    expect(new SolanaAddress(`  ${VALID}  `).canonical()).toBe(VALID);
  });

  it('rejects non-string input', () => {
    expect(() => new SolanaAddress(undefined as unknown as string)).toThrow();
    expect(() => new SolanaAddress(null as unknown as string)).toThrow();
    expect(() => new SolanaAddress(123 as unknown as string)).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => new SolanaAddress('')).toThrow();
    expect(() => new SolanaAddress('   ')).toThrow();
  });

  it('rejects base58 strings that decode to the wrong byte length', () => {
    // 'abc' is valid base58 but decodes to 3 bytes, not 32.
    expect(() => new SolanaAddress('abc')).toThrow();
  });

  it('rejects strings containing characters outside the base58 alphabet', () => {
    // '0', 'O', 'I', 'l' are forbidden in base58.
    expect(() => new SolanaAddress('0' + VALID.slice(1))).toThrow();
  });

  it('exposes the parsed PublicKey', () => {
    const addr = new SolanaAddress(VALID);
    expect(addr.pubkey.toBase58()).toBe(VALID);
  });
});
