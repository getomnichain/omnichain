import { networks } from 'bitcoinjs-lib';

export const Slip44 = {
  BTC: 0,
  Testnet: 1,
  LTC: 2,
  DOGE: 3,
} as const;

export type Slip44CoinId = (typeof Slip44)[keyof typeof Slip44] | number;

export const BIP32_PURPOSE_P2PKH = 44;
export const BIP32_PURPOSE_P2SH_P2WPKH = 49;
export const BIP32_PURPOSE_P2WPKH = 84;
export const BIP32_PURPOSE_P2TR = 86;

export const FINAL_SEQUENCE = 0xffffffff;
export const RBF_SEQUENCE = 0xfffffffd;
export const OP_RETURN_MAX_BYTES = 80;
export const DEFAULT_DUST_SATS = 546;

export interface UtxoNetworkParams {
  name: string;
  slip44CoinId: number;
  networkInfo: networks.Network;
  supportedDerivationPurposes: ReadonlySet<number>;
  dustValueSats: number;
  walletAddressRegex: RegExp;
}
