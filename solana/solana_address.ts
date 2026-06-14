import { PublicKey } from '@solana/web3.js';

import { Address } from '../address.ts';
import { NetworkType } from '../network_type.ts';

/**
 * Solana addresses are 32-byte ed25519 public keys, encoded in base58 (no fixed length but
 * always 32–44 chars after encoding). Validation defers to `PublicKey` which checks the
 * base58 alphabet, decodes, and asserts the 32-byte length.
 *
 * Unlike EVM there is no case-folding / EIP-55 checksum — every valid address has exactly
 * one canonical string form, so `canonical()` just returns the trimmed input verbatim once
 * we've confirmed it parses.
 */
export class SolanaAddress extends Address {
  readonly pubkey: PublicKey;

  constructor(raw: string) {
    super(SolanaAddress.assertValid(raw));
    this.pubkey = new PublicKey(this.raw);
  }

  canonical(): string {
    return this.raw;
  }

  get networkType(): NetworkType {
    return NetworkType.SOLANA;
  }

  private static assertValid(raw: string): string {
    if (typeof raw !== 'string') {
      throw new Error('Invalid Solana address: not a string');
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      throw new Error('Invalid Solana address: empty');
    }
    try {
      const pk = new PublicKey(trimmed);
      if (pk.toBytes().length !== 32) {
        throw new Error('Solana address must be 32 bytes');
      }
    } catch (err) {
      throw new Error(`Invalid Solana address: "${raw}": ${(err as Error).message}`);
    }
    return trimmed;
  }
}
