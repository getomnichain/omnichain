import { FiatCurrency } from '../chain_type.ts';
import { StellarAsset } from './stellar_asset.ts';
import { StellarMainnet, StellarTestnet } from './stellar_chains.ts';

export const STELLAR_XLM = StellarMainnet.nativeAsset;

export const STELLAR_USDC = StellarMainnet.createSacToken('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

export const STELLAR_EURC = StellarMainnet.createSacToken('EURC', 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2');

export const STELLAR_BNUSD = new StellarAsset({
  chainId: StellarMainnet.chainId,
  networkPassphrase: StellarMainnet.networkPassphrase,
  code: 'BnUSD',
  issuer: null,
  contractId: 'CCT4ZYIYZ3TUO2AWQFEOFGBZ6HQP3GW5TA37CK7CRZVFRDXYTHTYX7KP',
  decimals: 18,
});

export const STELLAR_TESTNET_XLM = StellarTestnet.nativeAsset;

export const STELLAR_TESTNET_USDC = StellarTestnet.createSacToken('USDC', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');

export const STELLAR_TESTNET_EURC = StellarTestnet.createSacToken('EURC', 'GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO');

export const STELLAR_MAINNET_STABLECOINS_PEG: ReadonlyMap<StellarAsset, FiatCurrency> = new Map<StellarAsset, FiatCurrency>([
  [STELLAR_USDC, FiatCurrency.USD],
  [STELLAR_EURC, FiatCurrency.EUR],
]);
