import { Arbitrum, Base, BnbChain, Ethereum } from './evm_chains.ts';

export const ETHEREUM_ETH = Ethereum.nativeToken;
export const ETHEREUM_USDC = Ethereum.getErc20Token(
  'USDC',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  6
);
export const ETHEREUM_USDT = Ethereum.getErc20Token(
  'USDT',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
  6
);

export const ARBITRUM_ETH = Arbitrum.nativeToken;
export const ARBITRUM_USDC = Arbitrum.getErc20Token(
  'USDC',
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  6
);
export const ARBITRUM_USDT = Arbitrum.getErc20Token(
  'USDT',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  6
);

export const BASE_ETH = Base.nativeToken;
export const BASE_USDC = Base.getErc20Token(
  'USDC',
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  6
);

export const BNB_BNB = BnbChain.nativeToken;
export const BNB_USDC = BnbChain.getErc20Token(
  'USDC',
  '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  18
);
export const BNB_USDT = BnbChain.getErc20Token(
  'USDT',
  '0x55d398326f99059fF775485246999027B3197955',
  18
);
