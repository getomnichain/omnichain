import { SolanaToken } from './solana_token.ts';
import { SolanaDevnet, SolanaMainnet, SolanaTestnet } from './solana_chains.ts';

/**
 * Pre-baked SolanaToken instances. Mirrors
 * omnichain-py/src/omnichain/impl/solana/assets.py — token-for-token.
 *
 * Note: SolanaToken doesn't distinguish TOKEN vs TOKEN_2022 program at
 * construction (that's resolved via `SolanaChain.resolveTokenProgramId` at
 * runtime by reading the mint account owner). All entries below use
 * `SolanaToken.spl(...)`; Token-2022 mints route through TOKEN_2022_PROGRAM_ID
 * automatically at transfer-build time.
 */

// assets.py:4-29 — Mainnet
export const SOLANA_SOL = SolanaMainnet.nativeToken;
export const SOLANA_USDC = SolanaToken.spl(
  SolanaMainnet.chainId,
  'USDC',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  6,
);
export const SOLANA_EURC = SolanaToken.spl(
  SolanaMainnet.chainId,
  'EURC',
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
  6,
);
export const SOLANA_WSOL = SolanaToken.spl(
  SolanaMainnet.chainId,
  'WSOL',
  'So11111111111111111111111111111111111111112',
  9,
);
export const SOLANA_PYUSD = SolanaToken.spl(
  SolanaMainnet.chainId,
  'PYUSD',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  6,
);
export const SOLANA_USDT = SolanaToken.spl(
  SolanaMainnet.chainId,
  'USDT',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  6,
);

// assets.py:31 — Testnet native
export const SOLANA_TESTNET_SOL = SolanaTestnet.nativeToken;

// assets.py:33-43 — Devnet
export const SOLANA_DEVNET_SOL = SolanaDevnet.nativeToken;
export const SOLANA_DEVNET_USDC = SolanaToken.spl(
  SolanaDevnet.chainId,
  'USDC',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  6,
);
export const SOLANA_DEVNET_EURC = SolanaToken.spl(
  SolanaDevnet.chainId,
  'EURC',
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr',
  6,
);
