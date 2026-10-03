import { Networks } from '@stellar/stellar-sdk';

import { CHAIN_ID_STELLAR_MAINNET, CHAIN_ID_STELLAR_TESTNET } from '../chain_ids.ts';
import { StellarChain } from './stellar_chain.ts';

export const StellarMainnet = new StellarChain({
  name: 'Stellar Mainnet',
  defaultHorizonUrl: 'https://horizon.stellar.org',
  defaultSorobanRpcUrl: 'https://mainnet.sorobanrpc.com',
  explorerUrl: 'https://stellar.expert/explorer/public',
  stellarExpertApiUrl: 'https://api.stellar.expert/explorer/public',
  networkPassphrase: Networks.PUBLIC,
  chainId: CHAIN_ID_STELLAR_MAINNET,
  chainAgnosticStellarIdentifier: 'pubnet',
});

export const StellarTestnet = new StellarChain({
  name: 'Stellar Testnet',
  defaultHorizonUrl: 'https://horizon-testnet.stellar.org',
  defaultSorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  explorerUrl: 'https://stellar.expert/explorer/testnet',
  stellarExpertApiUrl: 'https://api.stellar.expert/explorer/testnet',
  networkPassphrase: Networks.TESTNET,
  chainId: CHAIN_ID_STELLAR_TESTNET,
  chainAgnosticStellarIdentifier: 'testnet',
});

export const ALL_STELLAR_CHAINS: ReadonlyArray<StellarChain> = [StellarMainnet, StellarTestnet];
