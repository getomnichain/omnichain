import { PublicKey } from '@solana/web3.js';

import { Token } from '../token.ts';
import { SolanaAddress } from './solana_address.ts';

/**
 * On Solana, the "token identifier" is the mint address (a Solana address belonging to the
 * SPL Token program). Native SOL has no mint — represented as `identifier: undefined`,
 * matching the EVM-side convention for native ETH.
 *
 * The mint determines which Token program owns the asset (TOKEN_PROGRAM_ID vs
 * TOKEN_2022_PROGRAM_ID); that's resolved at runtime by `SolanaChain.resolveSplToken` because
 * we don't want to RPC for it at constant-construction time.
 */
export class SolanaToken extends Token {
  constructor(
    chainId: number,
    symbol: string,
    mintAddress: string | undefined,
    decimals: number,
  ) {
    super(chainId, symbol, mintAddress, decimals);
    if (mintAddress !== undefined) {
      // Validate base58 + 32-byte length.
      new SolanaAddress(mintAddress);
    }
  }

  get mintAddress(): string | undefined {
    return this.identifier;
  }

  get mintPubkey(): PublicKey | undefined {
    return this.identifier ? new PublicKey(this.identifier) : undefined;
  }

  static native(chainId: number, symbol = 'SOL', decimals = 9): SolanaToken {
    return new SolanaToken(chainId, symbol, undefined, decimals);
  }

  static spl(chainId: number, symbol: string, mintAddress: string, decimals: number): SolanaToken {
    return new SolanaToken(chainId, symbol, mintAddress, decimals);
  }
}
