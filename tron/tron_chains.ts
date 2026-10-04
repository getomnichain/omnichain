import { CHAIN_ID_TRON_MAINNET, CHAIN_ID_TRON_SHASTA } from '../chain_ids.ts';
import { TronChain } from './tron_chain.ts';

export const TronMainnet = new TronChain({
  name: 'Tron Mainnet',
  defaultRpcUrl: 'https://api.trongrid.io',
  explorerUrl: 'https://tronscan.org',
  chainId: CHAIN_ID_TRON_MAINNET,
});

export const TronShastaTestnet = new TronChain({
  name: 'Tron Shasta Testnet',
  defaultRpcUrl: 'https://api.shasta.trongrid.io',
  explorerUrl: 'https://shasta.tronscan.org',
  chainId: CHAIN_ID_TRON_SHASTA,
});

export const ALL_TRON_CHAINS: ReadonlyArray<TronChain> = [TronMainnet, TronShastaTestnet];
