import { networks } from 'bitcoinjs-lib';

import {
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_SIGNET,
  CHAIN_ID_BITCOIN_TESTNET,
} from '../../chain_ids.ts';
import { ChainError, ChainErrorKinds } from '../../errors.ts';
import {
  BIP32_PURPOSE_P2PKH,
  BIP32_PURPOSE_P2SH_P2WPKH,
  BIP32_PURPOSE_P2TR,
  BIP32_PURPOSE_P2WPKH,
  DEFAULT_DUST_SATS,
  Slip44,
  UtxoNetworkParams,
} from '../utxo_network_params.ts';

export const BtcNetworks = {
  Mainnet: 'mainnet',
  Testnet: 'testnet',
  Signet: 'signet',
  Regtest: 'regtest',
} as const;

export type BtcNetworkName = (typeof BtcNetworks)[keyof typeof BtcNetworks];

export interface BtcNetworkParams extends UtxoNetworkParams {
  name: BtcNetworkName;
  hrp: string;
}

const ALL_BTC_PURPOSES = new Set([
  BIP32_PURPOSE_P2PKH,
  BIP32_PURPOSE_P2SH_P2WPKH,
  BIP32_PURPOSE_P2WPKH,
  BIP32_PURPOSE_P2TR,
]);

export const BITCOIN_MAINNET_PARAMS: BtcNetworkParams = {
  name: BtcNetworks.Mainnet,
  hrp: 'bc',
  slip44CoinId: Slip44.BTC,
  networkInfo: networks.bitcoin,
  supportedDerivationPurposes: ALL_BTC_PURPOSES,
  dustValueSats: DEFAULT_DUST_SATS,
  walletAddressRegex: /^(bc1[qp][ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
};

export const BITCOIN_TESTNET_PARAMS: BtcNetworkParams = {
  name: BtcNetworks.Testnet,
  hrp: 'tb',
  slip44CoinId: Slip44.Testnet,
  networkInfo: networks.testnet,
  supportedDerivationPurposes: ALL_BTC_PURPOSES,
  dustValueSats: DEFAULT_DUST_SATS,
  walletAddressRegex: /^(tb1[qp][ac-hj-np-z02-9]{11,71}|[mn2][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
};

export const BITCOIN_SIGNET_PARAMS: BtcNetworkParams = {
  ...BITCOIN_TESTNET_PARAMS,
  name: BtcNetworks.Signet,
};

export const BITCOIN_REGTEST_PARAMS: BtcNetworkParams = {
  name: BtcNetworks.Regtest,
  hrp: 'bcrt',
  slip44CoinId: Slip44.Testnet,
  networkInfo: networks.regtest,
  supportedDerivationPurposes: ALL_BTC_PURPOSES,
  dustValueSats: DEFAULT_DUST_SATS,
  walletAddressRegex: /^(bcrt1[qp][ac-hj-np-z02-9]{11,71}|[mn2][a-km-zA-HJ-NP-Z1-9]{25,34})$/,
};

export function btcParamsByName(name: BtcNetworkName): BtcNetworkParams {
  switch (name) {
    case BtcNetworks.Mainnet:
      return BITCOIN_MAINNET_PARAMS;
    case BtcNetworks.Testnet:
      return BITCOIN_TESTNET_PARAMS;
    case BtcNetworks.Signet:
      return BITCOIN_SIGNET_PARAMS;
    case BtcNetworks.Regtest:
      return BITCOIN_REGTEST_PARAMS;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown Bitcoin network: ${String(exhaustive)}`);
    }
  }
}

const btcParamsByChainId = new Map<bigint, BtcNetworkParams>();

// Static seed for the canonical BTC chainIds so `addressFor(-1, 'bc1q…')`
// resolves without any consumer having constructed a BtcChain instance —
// symmetric with the NetworkType static seed. Custom BTC ids still register
// via the BtcChain constructor.
btcParamsByChainId.set(BigInt(CHAIN_ID_BITCOIN_MAINNET), BITCOIN_MAINNET_PARAMS);
btcParamsByChainId.set(BigInt(CHAIN_ID_BITCOIN_TESTNET), BITCOIN_TESTNET_PARAMS);
btcParamsByChainId.set(BigInt(CHAIN_ID_BITCOIN_SIGNET), BITCOIN_SIGNET_PARAMS);

/**
 * Register BTC network params for a chainId. Idempotent for identical params
 * (same object identity or deep-equal fields); throws
 * `ChainError(InvalidArgument)` on conflict — silently re-pointing
 * `addressFor(-1, …)` at a different network's grammar would let a base58
 * mainnet address validate as testnet and vice versa. Mirrors the guard on
 * `registerNonEvmChain`.
 */
export function registerBtcChainParams(chainId: bigint, params: BtcNetworkParams): void {
  const existing = btcParamsByChainId.get(chainId);
  if (existing !== undefined && existing !== params && existing.name !== params.name) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `BTC chainId ${chainId} already registered with params for network '${existing.name}'; refusing to reclassify as '${params.name}'`,
      { chainId: Number(chainId) },
    );
  }
  btcParamsByChainId.set(chainId, params);
}

export function btcParamsForChainId(chainId: bigint): BtcNetworkParams {
  const params = btcParamsByChainId.get(chainId);
  if (!params) {
    throw new ChainError(
      ChainErrorKinds.ChainNotSupported,
      `No BTC network params registered for chainId ${chainId}; construct a BtcChain with that id first`,
      { chainId: Number(chainId) },
    );
  }
  return params;
}
