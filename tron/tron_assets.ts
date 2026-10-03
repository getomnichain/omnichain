import { FiatCurrency } from '../chain_type.ts';
import { TronAsset } from './tron_asset.ts';
import { TronMainnet, TronShastaTestnet } from './tron_chains.ts';

export const TRON_TRX = TronMainnet.nativeAsset;

export const TRON_USDT = TronMainnet.getTrc20Asset('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);

export const TRON_USDC = TronMainnet.getTrc20Asset('USDC', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 6);

export const TRON_SHASTA_USDT = TronShastaTestnet.getTrc20Asset('USDT', 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs', 6);

export const TRON_SHASTA_TRX = TronShastaTestnet.nativeAsset;

export const TRON_ASSETS_REQUIRING_ZERO_RESET_APPROVAL: ReadonlyArray<TronAsset> = [TRON_USDT];

export const TRON_MAINNET_STABLECOINS_PEG: ReadonlyMap<TronAsset, FiatCurrency> = new Map<TronAsset, FiatCurrency>([
  [TRON_USDC, FiatCurrency.USD],
  [TRON_USDT, FiatCurrency.USD],
]);
