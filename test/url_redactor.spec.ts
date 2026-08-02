import { sanitizeMessage } from '../errors.ts';

describe('sanitizeMessage — URL redactor', () => {
  it('redacts long hex runs (signed-tx protection)', () => {
    const signedTx = '0x' + 'ab'.repeat(300);
    const msg = `broadcast failed with payload ${signedTx} on chain`;
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain(signedTx);
    expect(out).toMatch(/<signed-tx:\d+B>/);
  });

  it('redacts apiKey= query param', () => {
    const msg = 'error at https://x.rpc/?apiKey=SECRET_ABC123';
    expect(sanitizeMessage(msg, null)).toBe(
      'error at https://x.rpc/?apiKey=<redacted>',
    );
  });

  it('redacts api-key= (Helius shape)', () => {
    const msg = 'error at https://mainnet.helius-rpc.com/?api-key=SECRET';
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain('SECRET');
  });

  it('redacts Bearer token (case-insensitive)', () => {
    const msg = 'auth: Bearer aBc123._~-XyZ';
    expect(sanitizeMessage(msg, null)).toBe('auth: Bearer <redacted>');
    expect(sanitizeMessage('auth: bearer TOKEN', null)).toContain('<redacted>');
  });

  it('redacts path-embedded Alchemy key', () => {
    const msg =
      'GET https://eth-mainnet.g.alchemy.com/v2/aBcDeFgHiJkLmNoPqRs failed';
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain('aBcDeFgHiJkLmNoPqRs');
    expect(out).toContain('<redacted>');
  });

  it('redacts full Infura URL via known-provider rule', () => {
    const msg =
      'GET https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef failed';
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('redacts full QuickNode URL via known-provider rule', () => {
    const msg = 'GET https://x.quiknode.pro/aBcDeFgHiJkL/ failed';
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain('aBcDeFgHiJkL');
  });

  it('preserves non-sensitive substrings', () => {
    const msg = 'balance too low; nonce too low; try again';
    expect(sanitizeMessage(msg, null)).toBe(msg);
  });
});
