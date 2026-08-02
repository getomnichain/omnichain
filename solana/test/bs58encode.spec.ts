import { jest } from '@jest/globals';
import { PublicKey } from '@solana/web3.js';

import { bs58encode, signatureBase58FromBytes } from '../solana_chain.ts';

const encodeRef = (bytes: Uint8Array): string => {
  if (bytes.length !== 32) {
    throw new Error(`encodeRef takes 32 bytes (PublicKey uses toBase58); got ${bytes.length}`);
  }
  return new PublicKey(bytes).toBase58();
};

describe('bs58encode (hand-rolled) matches PublicKey.toBase58 (Solana reference)', () => {
  it('matches on a canonical 32-byte input (0..31)', () => {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = i;
    expect(bs58encode(bytes)).toBe(encodeRef(bytes));
  });

  it('matches on all-zeros 32-byte input (leading-zero handling)', () => {
    const bytes = new Uint8Array(32);
    expect(bs58encode(bytes)).toBe(encodeRef(bytes));
  });

  it('matches on 31 leading zeros + payload byte', () => {
    const bytes = new Uint8Array(32);
    bytes[31] = 0xff;
    expect(bs58encode(bytes)).toBe(encodeRef(bytes));
  });

  it('matches on random 32-byte pseudo-inputs (differential fuzz)', () => {
    for (let seed = 0; seed < 8; seed++) {
      const bytes = new Uint8Array(32);
      let x = seed * 0x9e3779b9 + 1;
      for (let i = 0; i < 32; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        bytes[i] = x & 0xff;
      }
      expect(bs58encode(bytes)).toBe(encodeRef(bytes));
    }
  });

  it('encodes a 64-byte input to canonical Solana signature length (88 chars) with alphabet-only output', () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bytes[i] = 0xff;
    const out = bs58encode(bytes);
    expect(out.length).toBe(88);
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    for (const ch of out) expect(ALPHABET).toContain(ch);
  });

  it('preserves leading-zero prefix in the 64-byte case', () => {
    const bytes = new Uint8Array(64);
    bytes[63] = 1;
    expect(bs58encode(bytes).startsWith('1'.repeat(63))).toBe(true);
  });
});

describe('signatureBase58FromBytes', () => {
  it('extracts the first 64 bytes past the num-sigs prefix and base58-encodes them', () => {
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = (i * 7 + 3) & 0xff;
    const txBytes = new Uint8Array(1 + 64 + 10);
    txBytes[0] = 1;
    txBytes.set(sig, 1);
    expect(signatureBase58FromBytes(txBytes)).toBe(bs58encode(sig));
  });

  it('throws ChainError(InvalidArgument) on too-short bytes', () => {
    expect(() => signatureBase58FromBytes(new Uint8Array(10))).toThrow(/too short/);
  });

  it('throws ChainError(InvalidArgument) when num_sigs is 0', () => {
    const bytes = new Uint8Array(1 + 64 + 10);
    bytes[0] = 0;
    expect(() => signatureBase58FromBytes(bytes)).toThrow(/no signatures/);
  });
});

jest.setTimeout(10_000);
