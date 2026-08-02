import { jest } from '@jest/globals';
import { createRequire } from 'module';
const nodeRequire = createRequire(import.meta.url);
const bs58Ref = nodeRequire('bs58') as { encode: (b: Uint8Array) => string } | { default: { encode: (b: Uint8Array) => string } };

import { bs58encode, signatureBase58FromBytes } from '../solana_chain.ts';

describe('bs58encode (hand-rolled) matches the reference bs58 package', () => {
  const encode = 'encode' in bs58Ref ? bs58Ref.encode.bind(bs58Ref) : bs58Ref.default.encode.bind(bs58Ref.default);

  it('matches on a canonical 64-byte signature (0..63)', () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bytes[i] = i;
    expect(bs58encode(bytes)).toBe(encode(bytes));
  });

  it('matches on all-zeros 64-byte signature', () => {
    const bytes = new Uint8Array(64);
    expect(bs58encode(bytes)).toBe(encode(bytes));
  });

  it('matches on 64 leading zeros + payload (verifies leading-zero handling)', () => {
    const bytes = new Uint8Array(64);
    bytes[63] = 0xff;
    expect(bs58encode(bytes)).toBe(encode(bytes));
  });

  it('matches on random 64-byte pseudo-signatures', () => {
    for (let seed = 0; seed < 8; seed++) {
      const bytes = new Uint8Array(64);
      let x = seed * 0x9e3779b9 + 1;
      for (let i = 0; i < 64; i++) {
        x = (x * 1103515245 + 12345) >>> 0;
        bytes[i] = x & 0xff;
      }
      expect(bs58encode(bytes)).toBe(encode(bytes));
    }
  });
});

describe('signatureBase58FromBytes', () => {
  it('extracts the first 64 bytes and base58-encodes them', () => {
    // Solana serialized tx: [num_sigs (1 byte)] [signature (64 bytes)] [message ...]
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = (i * 7 + 3) & 0xff;
    const txBytes = new Uint8Array(1 + 64 + 10);
    txBytes[0] = 1;
    txBytes.set(sig, 1);
    const bs58 = (bs58Ref as unknown as { encode: (b: Uint8Array) => string } | { default: { encode: (b: Uint8Array) => string } });
    const encode = 'encode' in bs58 ? bs58.encode.bind(bs58) : bs58.default.encode.bind(bs58.default);
    expect(signatureBase58FromBytes(txBytes)).toBe(encode(sig));
  });

  it('throws ChainError(InvalidArgument) on too-short bytes', () => {
    const short = new Uint8Array(10);
    expect(() => signatureBase58FromBytes(short)).toThrow(/too short/);
  });

  it('throws ChainError(InvalidArgument) when num_sigs is 0', () => {
    const bytes = new Uint8Array(1 + 64 + 10);
    bytes[0] = 0;
    expect(() => signatureBase58FromBytes(bytes)).toThrow(/no signatures/);
  });
});

// silence lint for jest import when only spec-level; ensure it's used
jest.setTimeout(10_000);
