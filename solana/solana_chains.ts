import { SolanaChain } from './solana_chain.ts';

/**
 * Solana has no EIP-155 chain ID. Depositron assigns synthetic negative IDs in the same
 * scheme as BTC (-1..-4) and LTC (-10/-11): Solana mainnet = -100, testnet = -101, devnet
 * = -102. CAIP-2 identifies them by the first 32 chars of the genesis block hash.
 */
export const SOLANA_MAINNET_CHAIN_ID = -100;
export const SOLANA_TESTNET_CHAIN_ID = -101;
export const SOLANA_DEVNET_CHAIN_ID = -102;

export const SolanaMainnet = new SolanaChain({
  chainId: SOLANA_MAINNET_CHAIN_ID,
  name: 'Solana',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  nativeSymbol: 'SOL',
  rpcEnvVar: 'SOLANA_RPC_URL',
  chainAgnosticGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
});

export const SolanaTestnet = new SolanaChain({
  chainId: SOLANA_TESTNET_CHAIN_ID,
  name: 'Solana Testnet',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  explorerClusterSuffix: '?cluster=testnet',
  nativeSymbol: 'SOL',
  rpcEnvVar: 'SOLANA_TESTNET_RPC_URL',
  chainAgnosticGenesisHash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
});

export const SolanaDevnet = new SolanaChain({
  chainId: SOLANA_DEVNET_CHAIN_ID,
  name: 'Solana Devnet',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  explorerClusterSuffix: '?cluster=devnet',
  nativeSymbol: 'SOL',
  rpcEnvVar: 'SOLANA_DEVNET_RPC_URL',
  chainAgnosticGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
});

export const ALL_SOLANA_CHAINS: ReadonlyArray<SolanaChain> = [
  SolanaMainnet,
  SolanaTestnet,
  SolanaDevnet,
];
