import { EvmChain } from './evm_chain.ts';

export const ETHEREUM_CHAIN_ID = 1;
export const ARBITRUM_CHAIN_ID = 42161;
export const BASE_CHAIN_ID = 8453;
export const BNB_CHAIN_ID = 56;

export const Ethereum = new EvmChain({
  chainId: ETHEREUM_CHAIN_ID,
  name: 'Ethereum',
  blockTimeSeconds: 12,
  explorerBaseUrl: 'https://etherscan.io',
  nativeSymbol: 'ETH',
  rpcEnvVar: 'ETHEREUM_RPC_URL',
});

export const Arbitrum = new EvmChain({
  chainId: ARBITRUM_CHAIN_ID,
  name: 'Arbitrum',
  blockTimeSeconds: 0.25,
  explorerBaseUrl: 'https://arbiscan.io',
  nativeSymbol: 'ETH',
  rpcEnvVar: 'ARBITRUM_RPC_URL',
});

export const Base = new EvmChain({
  chainId: BASE_CHAIN_ID,
  name: 'Base',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://basescan.org',
  nativeSymbol: 'ETH',
  rpcEnvVar: 'BASE_RPC_URL',
});

export const BnbChain = new EvmChain({
  chainId: BNB_CHAIN_ID,
  name: 'BNB Chain',
  blockTimeSeconds: 3,
  explorerBaseUrl: 'https://bscscan.com',
  nativeSymbol: 'BNB',
  rpcEnvVar: 'BNB_RPC_URL',
});

export const ALL_EVM_CHAINS: ReadonlyArray<EvmChain> = [Ethereum, Arbitrum, Base, BnbChain];
