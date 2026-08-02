import { jest } from '@jest/globals';
import { sanitizeUtxoErrMessage } from '../utxo_chain.ts';

describe('sanitizeUtxoErrMessage', () => {
  it('redacts a 32+ hex path segment (UTXO provider key in URL path)', () => {
    const msg = 'POST https://btc.example.com/0123456789abcdef0123456789abcdef/tx failed';
    const out = sanitizeUtxoErrMessage(msg);
    expect(out).not.toContain('0123456789abcdef0123456789abcdef');
    expect(out).toContain('/***');
  });

  it('redacts a 64-hex path segment (tx-hash-like path — accepted collateral)', () => {
    const msg = 'GET https://blockstream.info/api/tx/1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff/status returned 500';
    const out = sanitizeUtxoErrMessage(msg);
    expect(out).not.toContain('1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff');
  });

  it('redacts basic-auth credentials in the URL', () => {
    const msg = 'connect http://alice:hunter2@node.example.com:8332 refused';
    const out = sanitizeUtxoErrMessage(msg);
    expect(out).not.toContain('alice');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***:***@');
  });

  it('redacts pk_/sk_/ghp_/gho_ provider key markers (contiguous alphanumeric tail)', () => {
    const msg = 'auth failed with key sk_A1B2C3D4E5F6G7H8I9J0KLMNOP and gho_ghtokenABCDEFGHIJKLM';
    const out = sanitizeUtxoErrMessage(msg);
    expect(out).not.toContain('sk_A1B2C3D4E5F6G7H8I9J0KLMNOP');
    expect(out).not.toContain('gho_ghtokenABCDEFGHIJKLM');
  });

  it('inherits the shared signed-bytes redaction (routes through sanitizeMessage)', () => {
    const signedTx = '0x' + 'ab'.repeat(200);
    const out = sanitizeUtxoErrMessage(`broadcast body ${signedTx}`);
    expect(out).not.toContain(signedTx);
    expect(out).toMatch(/<signed-bytes:\d+B>/);
  });

  it('inherits the shared ?auth= redaction', () => {
    const msg = 'GET https://esplora.example.com/api/tx?auth=sk_live_SECRETXYZ failed';
    const out = sanitizeUtxoErrMessage(msg);
    expect(out).not.toContain('sk_live_SECRETXYZ');
    expect(out).toContain('?auth=<redacted>');
  });

  it('inherits the shared bare Authorization: redaction', () => {
    const msg = 'req headers Authorization: aBc123.tokenXYZ';
    const out = sanitizeUtxoErrMessage(msg);
    expect(out).not.toContain('aBc123.tokenXYZ');
    expect(out).toContain('Authorization: <redacted>');
  });
});

jest.setTimeout(10_000);
