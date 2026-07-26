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

const RESERVED_SEED_CHAIN_IDS = new Set<bigint>([
  BigInt(CHAIN_ID_BITCOIN_MAINNET),
  BigInt(CHAIN_ID_BITCOIN_TESTNET),
  BigInt(CHAIN_ID_BITCOIN_SIGNET),
]);

// Static seed for the canonical BTC chainIds so `addressFor(-1, 'bc1q…')`
// resolves without any consumer having constructed a BtcChain instance —
// symmetric with the NetworkType static seed. Custom BTC ids still register
// via the BtcChain constructor.
btcParamsByChainId.set(BigInt(CHAIN_ID_BITCOIN_MAINNET), BITCOIN_MAINNET_PARAMS);
btcParamsByChainId.set(BigInt(CHAIN_ID_BITCOIN_TESTNET), BITCOIN_TESTNET_PARAMS);
btcParamsByChainId.set(BigInt(CHAIN_ID_BITCOIN_SIGNET), BITCOIN_SIGNET_PARAMS);

/**
 * Register BTC network params for a chainId.
 *
 * The three statically-seeded chainIds (BTC mainnet/testnet/signet) are
 * **reserved** — any attempt to re-register them throws
 * `ChainError(InvalidArgument)`, even with matching-name params. This
 * prevents a hostile consumer replacing e.g. mainnet's `hrp` field with
 * a differently-shaped grammar. If you need custom BTC-shaped params,
 * choose a distinct (non-seed) chainId.
 *
 * For non-seeded chainIds, the guard compares identity-relevant fields
 * (`hrp`, `pubKeyHash`, `scriptHash`, `bip32` derivation info) rather
 * than the `name` alone — silent-replace-with-different-grammar is not
 * possible on any registered id, seeded or not.
 */
export function registerBtcChainParams(chainId: bigint, params: BtcNetworkParams): void {
  if (RESERVED_SEED_CHAIN_IDS.has(chainId)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `BTC chainId ${chainId} is a reserved static seed; consumer registration is not permitted. Choose a distinct chainId for custom BTC-shaped params.`,
      { chainId: Number(chainId) },
    );
  }
  const existing = btcParamsByChainId.get(chainId);
  if (existing !== undefined && existing !== params) {
    if (!btcParamsShapeMatches(existing, params)) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `BTC chainId ${chainId} already registered with different identity-relevant params ('${existing.name}' vs '${params.name}'). Consumer must unregister first if intentional.`,
        { chainId: Number(chainId) },
      );
    }
  }
  btcParamsByChainId.set(chainId, params);
}

/**
 * Remove a consumer-registered BTC chainId entry. The three static seeds
 * (BTC mainnet/testnet/signet) cannot be unregistered — throws
 * `ChainError(InvalidArgument)` on those ids.
 *
 * Paired with `unregisterChain(id)` from `network_type.ts` when the
 * consumer wants a full teardown of a custom BTC-shaped id: both
 * registries need clearing to avoid drift where `networkTypeOf(id)`
 * throws `ChainNotSupported` but `btcParamsForChainId(id)` still returns
 * stale params.
 */
export function unregisterBtcChainParams(chainId: bigint): void {
  if (RESERVED_SEED_CHAIN_IDS.has(chainId)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `BTC chainId ${chainId} is a reserved static seed; unregistration not permitted.`,
      { chainId: Number(chainId) },
    );
  }
  btcParamsByChainId.delete(chainId);
}

function btcParamsShapeMatches(a: BtcNetworkParams, b: BtcNetworkParams): boolean {
  return (
    a.hrp === b.hrp &&
    a.slip44CoinId === b.slip44CoinId &&
    a.networkInfo.pubKeyHash === b.networkInfo.pubKeyHash &&
    a.networkInfo.scriptHash === b.networkInfo.scriptHash &&
    a.networkInfo.bip32.public === b.networkInfo.bip32.public &&
    a.networkInfo.bip32.private === b.networkInfo.bip32.private
  );
}

export function btcParamsForChainId(chainId: bigint): BtcNetworkParams {
  const params = btcParamsByChainId.get(chainId);
  if (!params) {
    // Do NOT tell the caller to register — for non-BTC UTXO chainIds
    // (LTC/DOGE/etc.), registering BITCOIN_MAINNET_PARAMS here would let
    // BTC addresses validate as if they belonged to the wrong chain.
    // The v0 workaround is `chain.validateAddress(raw)` on the chain
    // instance directly; see docs/UPGRADE_TO_V0.md.
    throw new ChainError(
      ChainErrorKinds.ChainNotSupported,
      `No BTC network params registered for chainId ${chainId}`,
      { chainId: Number(chainId) },
    );
  }
  return params;
}
