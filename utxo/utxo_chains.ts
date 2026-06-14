import { BtcChain } from './btc/btc_chain.ts';
import {
  BitcoinChainFactoryOptions,
  bitcoinMainnetChain,
  bitcoinRegtestChain,
  bitcoinSignetChain,
  bitcoinTestnetChain,
} from './btc/btc_chains.ts';
import {
  DogecoinChainFactoryOptions,
  dogecoinMainnetChain,
  dogecoinTestnetChain,
} from './doge/doge_chains.ts';
import {
  LitecoinChainFactoryOptions,
  litecoinMainnetChain,
  litecoinTestnetChain,
} from './ltc/ltc_chains.ts';
import { UtxoChain } from './utxo_chain.ts';
import { Slip44 } from './utxo_network_params.ts';

export const UtxoCoin = {
  Bitcoin: 'bitcoin',
  BitcoinTestnet: 'bitcoin-testnet',
  BitcoinSignet: 'bitcoin-signet',
  BitcoinRegtest: 'bitcoin-regtest',
  Litecoin: 'litecoin',
  LitecoinTestnet: 'litecoin-testnet',
  Dogecoin: 'dogecoin',
  DogecoinTestnet: 'dogecoin-testnet',
} as const;

export type UtxoCoinName = (typeof UtxoCoin)[keyof typeof UtxoCoin];

export type UtxoChainFactoryOptions =
  | (BitcoinChainFactoryOptions & { coin: 'bitcoin' | 'bitcoin-testnet' | 'bitcoin-signet' | 'bitcoin-regtest' })
  | (LitecoinChainFactoryOptions & { coin: 'litecoin' | 'litecoin-testnet' })
  | (DogecoinChainFactoryOptions & { coin: 'dogecoin' | 'dogecoin-testnet' });

export function utxoChainFromCoin(options: UtxoChainFactoryOptions): UtxoChain {
  switch (options.coin) {
    case UtxoCoin.Bitcoin:
      return bitcoinMainnetChain(options);
    case UtxoCoin.BitcoinTestnet:
      return bitcoinTestnetChain(options);
    case UtxoCoin.BitcoinSignet:
      return bitcoinSignetChain(options);
    case UtxoCoin.BitcoinRegtest:
      return bitcoinRegtestChain(options);
    case UtxoCoin.Litecoin:
      return litecoinMainnetChain(options);
    case UtxoCoin.LitecoinTestnet:
      return litecoinTestnetChain(options);
    case UtxoCoin.Dogecoin:
      return dogecoinMainnetChain(options);
    case UtxoCoin.DogecoinTestnet:
      return dogecoinTestnetChain(options);
    default: {
      const exhaustive: never = options;
      throw new Error(`utxoChainFromCoin: unknown coin ${(exhaustive as { coin: string }).coin}`);
    }
  }
}

export function utxoChainFromSlip44(
  slip44CoinId: number,
  isMainnet: boolean,
  options:
    | (BitcoinChainFactoryOptions & { variant?: 'mainnet' | 'testnet' | 'signet' | 'regtest' })
    | LitecoinChainFactoryOptions
    | DogecoinChainFactoryOptions
): UtxoChain {
  if (isMainnet) {
    if (slip44CoinId === Slip44.BTC) return bitcoinMainnetChain(options as BitcoinChainFactoryOptions);
    if (slip44CoinId === Slip44.LTC) return litecoinMainnetChain(options as LitecoinChainFactoryOptions);
    if (slip44CoinId === Slip44.DOGE) return dogecoinMainnetChain(options as DogecoinChainFactoryOptions);
    throw new Error(`utxoChainFromSlip44: no mainnet chain for SLIP-44 coin ${slip44CoinId}`);
  }
  const variant = (options as { variant?: 'mainnet' | 'testnet' | 'signet' | 'regtest' }).variant ?? 'testnet';
  if (slip44CoinId === Slip44.BTC || slip44CoinId === Slip44.Testnet) {
    if (variant === 'signet') return bitcoinSignetChain(options as BitcoinChainFactoryOptions);
    if (variant === 'regtest') return bitcoinRegtestChain(options as BitcoinChainFactoryOptions);
    return bitcoinTestnetChain(options as BitcoinChainFactoryOptions);
  }
  if (slip44CoinId === Slip44.LTC) return litecoinTestnetChain(options as LitecoinChainFactoryOptions);
  if (slip44CoinId === Slip44.DOGE) return dogecoinTestnetChain(options as DogecoinChainFactoryOptions);
  throw new Error(`utxoChainFromSlip44: no testnet chain for SLIP-44 coin ${slip44CoinId}`);
}

export type { BtcChain };
