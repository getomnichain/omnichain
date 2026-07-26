import {
  CHAIN_ID_SOLANA_DEVNET,
  CHAIN_ID_SOLANA_MAINNET,
  CHAIN_ID_SOLANA_TESTNET,
} from '../chain_ids.ts';
import { SolanaChain } from './solana_chain.ts';

/**
 * Solana chain constants and pre-baked instances. Mirrors
 * omnichain-py/src/omnichain/impl/solana/chains.py.
 *
 * Chain IDs match Python's -2000/-2001/-2002 scheme (chain_ids.py:43-45).
 * Chain names include the cluster suffix ("Solana Mainnet", "Solana Testnet",
 * "Solana Devnet") so `<NAME>_RPC_URL` env-var derivation is unambiguous.
 */

// Re-export for backward-compat with any consumer that used the old local names.
export const SOLANA_MAINNET_CHAIN_ID = CHAIN_ID_SOLANA_MAINNET;
export const SOLANA_TESTNET_CHAIN_ID = CHAIN_ID_SOLANA_TESTNET;
export const SOLANA_DEVNET_CHAIN_ID = CHAIN_ID_SOLANA_DEVNET;

// Predefined factories don't set rpcUrl — SolanaChain's fallback chain is:
//   <NAME_UPPERCASE_UNDERSCORED>_RPC_URL env,
//   then SOLANA_<chainId>_RPC_URL env (mirrors Python impl/solana/base.py:424-434),
//   then defaultRpcUrl (public cluster). Solana never throws "not configured".

export const SolanaMainnet = new SolanaChain({
  chainId: CHAIN_ID_SOLANA_MAINNET,
  name: 'Solana Mainnet',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  nativeSymbol: 'SOL',
  defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
  chainAgnosticGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
});

export const SolanaTestnet = new SolanaChain({
  chainId: CHAIN_ID_SOLANA_TESTNET,
  name: 'Solana Testnet',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  explorerClusterSuffix: '?cluster=testnet',
  nativeSymbol: 'SOL',
  defaultRpcUrl: 'https://api.testnet.solana.com',
  chainAgnosticGenesisHash: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
});

export const SolanaDevnet = new SolanaChain({
  chainId: CHAIN_ID_SOLANA_DEVNET,
  name: 'Solana Devnet',
  blockTimeSeconds: 0.4,
  explorerBaseUrl: 'https://solscan.io',
  explorerClusterSuffix: '?cluster=devnet',
  nativeSymbol: 'SOL',
  defaultRpcUrl: 'https://api.devnet.solana.com',
  chainAgnosticGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
});

export const ALL_SOLANA_CHAINS: ReadonlyArray<SolanaChain> = [
  SolanaMainnet,
  SolanaTestnet,
  SolanaDevnet,
];
