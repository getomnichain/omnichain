import { sanitizeMessage } from '../errors.ts';

describe('sanitizeMessage — URL redactor', () => {
  it('redacts long hex runs (signed-tx protection)', () => {
    const signedTx = '0x' + 'ab'.repeat(300);
    const msg = `broadcast failed with payload ${signedTx} on chain`;
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain(signedTx);
    expect(out).toMatch(/<signed-bytes:\d+B>/);
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

  it('redacts ?auth= query param (Blockstream/Esplora shape)', () => {
    const msg = 'GET https://blockstream.info/api/tx?auth=sk_live_ABC123 → 401';
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain('sk_live_ABC123');
    expect(out).toContain('?auth=<redacted>');
  });

  it('redacts bare Authorization header value (no Bearer keyword)', () => {
    const msg = 'axios req headers: Authorization: aBc123.token';
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain('aBc123.token');
    expect(out).toContain('Authorization: <redacted>');
  });

  it('redacts x-api-key: header value (Helius/Alchemy/QuickNode shape)', () => {
    const out = sanitizeMessage('req headers: x-api-key: SECRETVALUE123abc', null);
    expect(out).not.toContain('SECRETVALUE123abc');
    expect(out).toContain('x-api-key: <redacted>');
  });

  it('redacts api-key / api_key / Api-Key case variants', () => {
    expect(sanitizeMessage('Api-Key: SECRET123abc', null)).toContain('<redacted>');
    expect(sanitizeMessage('X-Api-Key: SECRET123abc', null)).toContain('<redacted>');
    expect(sanitizeMessage('api_key: SECRET123abc', null)).toContain('<redacted>');
  });

  it('redacts /vN/ key when terminated by comma (axios wrapping)', () => {
    const out = sanitizeMessage('POST https://rpc.selfhosted.io/v3/AbCdEfGhIjKlMnOpQrSt, retrying', null);
    expect(out).not.toContain('AbCdEfGhIjKlMnOpQrSt');
    expect(out).toContain('/v3/<redacted>');
  });

  it('redacts /vN/ key wrapped in parens (log context wrapping)', () => {
    const out = sanitizeMessage('failed (url: https://x.example/v3/AbCdEfGhIjKlMnOpQrSt)', null);
    expect(out).not.toContain('AbCdEfGhIjKlMnOpQrSt');
    expect(out).toContain('/v3/<redacted>');
  });

  it('redacts /rpc/ path segment (self-hosted provider convention)', () => {
    const out = sanitizeMessage('POST https://rpc.selfhosted.io/rpc/AbCdEfGhIjKlMnOpQrSt/tx', null);
    expect(out).not.toContain('AbCdEfGhIjKlMnOpQrSt');
    expect(out).toContain('/rpc/<redacted>');
  });

  it('redacts Authorization: Bearer combined form (either rule wins)', () => {
    const msg = 'Authorization: Bearer TOK_ABC';
    const out = sanitizeMessage(msg, null);
    expect(out).not.toContain('TOK_ABC');
  });

  it('preserves non-sensitive substrings (UTXO hex-path rule is applied by sanitizeUtxoErrMessage, not the shared sanitizer)', () => {
    const msg = 'balance too low; nonce too low; try again';
    expect(sanitizeMessage(msg, null)).toBe(msg);
  });
});
