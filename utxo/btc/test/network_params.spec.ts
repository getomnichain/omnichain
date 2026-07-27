import { networks } from 'bitcoinjs-lib';

import {
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_TESTNET,
  CHAIN_ID_BITCOIN_SIGNET,
} from '../../../chain_ids.ts';
import { ChainErrorKinds, isChainError } from '../../../errors.ts';
import {
  BITCOIN_MAINNET_PARAMS,
  BITCOIN_TESTNET_PARAMS,
  BITCOIN_SIGNET_PARAMS,
  BtcNetworkParams,
  btcParamsForChainId,
  btcParamsShapeMatches,
  registerBtcChainParams,
  unregisterBtcChainParams,
} from '../network_params.ts';

const MAINNET = BigInt(CHAIN_ID_BITCOIN_MAINNET);
const TESTNET = BigInt(CHAIN_ID_BITCOIN_TESTNET);
const SIGNET = BigInt(CHAIN_ID_BITCOIN_SIGNET);
const CUSTOM = 99n;

describe('registerBtcChainParams — reserved-seed idempotency', () => {
  it('accepts re-registration of a seeded id with identity-equal params', () => {
    expect(() => registerBtcChainParams(MAINNET, BITCOIN_MAINNET_PARAMS)).not.toThrow();
  });

  it('accepts re-registration of a seeded id with shape-identical (different object) params', () => {
    const clone = { ...BITCOIN_MAINNET_PARAMS };
    expect(() => registerBtcChainParams(MAINNET, clone)).not.toThrow();
  });

  it('rejects re-registration of a seeded id with a different hrp', () => {
    const bad = { ...BITCOIN_MAINNET_PARAMS, hrp: 'tb' };
    try {
      registerBtcChainParams(MAINNET, bad);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects re-registration of a seeded id with a different walletAddressRegex', () => {
    const bad = { ...BITCOIN_MAINNET_PARAMS, walletAddressRegex: /^.*$/ };
    try {
      registerBtcChainParams(MAINNET, bad);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects a bech32-swap that would otherwise silently pass (iter-4 finding)', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      networkInfo: { ...BITCOIN_MAINNET_PARAMS.networkInfo, bech32: 'tb' },
    };
    try {
      registerBtcChainParams(MAINNET, bad);
      fail('expected throw — bech32 spoof must be caught');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects a messagePrefix swap on a seeded id', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      networkInfo: {
        ...BITCOIN_MAINNET_PARAMS.networkInfo,
        messagePrefix: '\x18Fake Signed Message:\n',
      },
    };
    try {
      registerBtcChainParams(MAINNET, bad);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('rejects a wif-byte swap on a seeded id', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      networkInfo: { ...BITCOIN_MAINNET_PARAMS.networkInfo, wif: 0xef },
    };
    try {
      registerBtcChainParams(MAINNET, bad);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('registerBtcChainParams — consumer (non-seeded) ids', () => {
  afterEach(() => unregisterBtcChainParams(CUSTOM));

  it('accepts a fresh consumer registration', () => {
    expect(() =>
      registerBtcChainParams(CUSTOM, {
        ...BITCOIN_MAINNET_PARAMS,
        name: 'mainnet',
      }),
    ).not.toThrow();
    expect(btcParamsForChainId(CUSTOM).hrp).toBe('bc');
  });

  it('re-registration with the same identity-relevant shape succeeds', () => {
    registerBtcChainParams(CUSTOM, { ...BITCOIN_MAINNET_PARAMS });
    expect(() => registerBtcChainParams(CUSTOM, { ...BITCOIN_MAINNET_PARAMS })).not.toThrow();
  });

  it('re-registration with a shape-differing regex throws', () => {
    registerBtcChainParams(CUSTOM, { ...BITCOIN_MAINNET_PARAMS });
    try {
      registerBtcChainParams(CUSTOM, {
        ...BITCOIN_MAINNET_PARAMS,
        walletAddressRegex: /^.*$/,
      });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });
});

describe('unregisterBtcChainParams', () => {
  it('is a no-op on reserved seed ids', () => {
    expect(() => unregisterBtcChainParams(MAINNET)).not.toThrow();
    expect(() => unregisterBtcChainParams(TESTNET)).not.toThrow();
    expect(() => unregisterBtcChainParams(SIGNET)).not.toThrow();
    // Seeded entries survive the no-op.
    expect(btcParamsForChainId(MAINNET).name).toBe('mainnet');
  });

  it('deletes a consumer registration', () => {
    registerBtcChainParams(CUSTOM, { ...BITCOIN_MAINNET_PARAMS });
    expect(() => btcParamsForChainId(CUSTOM)).not.toThrow();
    unregisterBtcChainParams(CUSTOM);
    try {
      btcParamsForChainId(CUSTOM);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.ChainNotSupported)).toBe(true);
    }
  });
});

describe('btcParamsShapeMatches — per-field discrimination', () => {
  it('identical params match', () => {
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, BITCOIN_MAINNET_PARAMS)).toBe(true);
  });

  it('shape-clone matches', () => {
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, { ...BITCOIN_MAINNET_PARAMS })).toBe(true);
  });

  it('name mismatch → false (signet vs testnet)', () => {
    // Signet is {...testnet, name: 'signet'} — same everything except name.
    expect(btcParamsShapeMatches(BITCOIN_TESTNET_PARAMS, BITCOIN_SIGNET_PARAMS)).toBe(false);
  });

  it('bech32 spoof → false', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      networkInfo: { ...BITCOIN_MAINNET_PARAMS.networkInfo, bech32: 'tb' },
    };
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, bad)).toBe(false);
  });

  it('messagePrefix mismatch → false', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      networkInfo: {
        ...BITCOIN_MAINNET_PARAMS.networkInfo,
        messagePrefix: '\x18Different:\n',
      },
    };
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, bad)).toBe(false);
  });

  it('wif mismatch → false', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      networkInfo: { ...BITCOIN_MAINNET_PARAMS.networkInfo, wif: 0xef },
    };
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, bad)).toBe(false);
  });

  it('walletAddressRegex source mismatch → false', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      walletAddressRegex: /^.*$/,
    };
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, bad)).toBe(false);
  });

  it('supportedDerivationPurposes contents mismatch → false', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      supportedDerivationPurposes: new Set([44]),
    };
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, bad)).toBe(false);
  });

  it('dustValueSats mismatch → false', () => {
    const bad = { ...BITCOIN_MAINNET_PARAMS, dustValueSats: 1000 };
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, bad)).toBe(false);
  });

  it('bip32.public mismatch → false', () => {
    const bad: BtcNetworkParams = {
      ...BITCOIN_MAINNET_PARAMS,
      networkInfo: {
        ...BITCOIN_MAINNET_PARAMS.networkInfo,
        bip32: { ...BITCOIN_MAINNET_PARAMS.networkInfo.bip32, public: 0x12345678 },
      },
    };
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, bad)).toBe(false);
  });

  it('slip44CoinId mismatch → false', () => {
    const bad = { ...BITCOIN_MAINNET_PARAMS, slip44CoinId: 2 };
    expect(btcParamsShapeMatches(BITCOIN_MAINNET_PARAMS, bad)).toBe(false);
  });

  // Sanity: bitcoinjs-lib's `networks.bitcoin` is the reference object.
  it('BITCOIN_MAINNET_PARAMS.networkInfo === networks.bitcoin (object identity)', () => {
    expect(BITCOIN_MAINNET_PARAMS.networkInfo).toBe(networks.bitcoin);
  });
});
