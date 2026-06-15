import { sign as nodeSign, createPrivateKey } from 'node:crypto';
import { Keypair } from '@solana/web3.js';

import { SolanaMainnet } from '../solana_chains.ts';

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
  const digits: number[] = [];
  for (let i = leadingZeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      const x = digits[j] * 256 + carry;
      digits[j] = x % 58;
      carry = Math.floor(x / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (let i = 0; i < leadingZeros; i++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

function signEd25519(message: string, secretKey: Uint8Array): Buffer {
  // secretKey is the 64-byte expanded secret (seed || pubkey). Node needs the raw 32-byte seed in PKCS#8.
  const seed = Buffer.from(secretKey.slice(0, 32));
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const keyObj = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  return nodeSign(null, Buffer.from(message, 'utf8'), keyObj);
}

describe('SolanaChain.verifyMessageSignature', () => {
  const message = 'Pluton login nonce 7f3a2c91';
  const kp = Keypair.generate();
  const signer = kp.publicKey.toBase58();

  it('returns true for a valid signature in hex', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer,
      signature: sig.toString('hex'),
    });
    expect(ok).toBe(true);
  });

  it('accepts hex with 0x prefix', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer,
      signature: '0x' + sig.toString('hex'),
    });
    expect(ok).toBe(true);
  });

  it('accepts base58 signature (Phantom convention)', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer,
      signature: base58Encode(sig),
    });
    expect(ok).toBe(true);
  });

  it('returns false when the message differs', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const ok = await SolanaMainnet.verifyMessageSignature({
      message: message + ' tampered',
      signer,
      signature: sig.toString('hex'),
    });
    expect(ok).toBe(false);
  });

  it('returns false when the signer differs', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const other = Keypair.generate();
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer: other.publicKey.toBase58(),
      signature: sig.toString('hex'),
    });
    expect(ok).toBe(false);
  });

  it('returns false for a malformed signature', async () => {
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer,
      signature: 'not-a-signature',
    });
    expect(ok).toBe(false);
  });

  it('returns false for a malformed signer', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer: 'not-a-pubkey',
      signature: sig.toString('hex'),
    });
    expect(ok).toBe(false);
  });

  it('returns false for a 32-byte truncated signature', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer,
      signature: sig.subarray(0, 32).toString('hex'),
    });
    expect(ok).toBe(false);
  });
});
