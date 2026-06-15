import { sign as nodeSign, createPrivateKey } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

import { SolanaMainnet } from '../solana_chains.ts';

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
      signature: bs58.encode(sig),
    });
    expect(ok).toBe(true);
  });

  it('rejects base64 signature (not an accepted encoding)', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer,
      signature: sig.toString('base64'),
    });
    expect(ok).toBe(false);
  });

  it('returns false for a signer that is valid base58 but the wrong length', async () => {
    const sig = signEd25519(message, kp.secretKey);
    const ok = await SolanaMainnet.verifyMessageSignature({
      message,
      signer: bs58.encode(new Uint8Array(16)),
      signature: sig.toString('hex'),
    });
    expect(ok).toBe(false);
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
