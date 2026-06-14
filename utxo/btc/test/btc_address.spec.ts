import { address as bjsAddress } from 'bitcoinjs-lib';

import '../../ecc.ts';
import { BtcAddress } from '../btc_address.ts';
import {
  BITCOIN_MAINNET_PARAMS,
  BITCOIN_REGTEST_PARAMS,
  BITCOIN_TESTNET_PARAMS,
} from '../network_params.ts';
import { UtxoScriptTypes } from '../../script.ts';

const MAINNET_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const MAINNET_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const MAINNET_P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const MAINNET_P2TR = 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';
const TESTNET_P2WPKH = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const REGTEST_P2WPKH = (() => {
  const decoded = bjsAddress.fromBech32(TESTNET_P2WPKH);
  return bjsAddress.toBech32(Buffer.from(decoded.data), decoded.version, 'bcrt');
})();

describe('BtcAddress — mainnet', () => {
  it('accepts a P2PKH address and identifies the script type', () => {
    const addr = new BtcAddress(MAINNET_P2PKH, BITCOIN_MAINNET_PARAMS);
    expect(addr.canonical()).toBe(MAINNET_P2PKH);
    expect(addr.scriptType).toBe(UtxoScriptTypes.P2PKH);
  });

  it('accepts a P2SH address', () => {
    const addr = new BtcAddress(MAINNET_P2SH, BITCOIN_MAINNET_PARAMS);
    expect(addr.scriptType).toBe(UtxoScriptTypes.P2SH);
  });

  it('accepts a P2WPKH (bech32) address', () => {
    const addr = new BtcAddress(MAINNET_P2WPKH, BITCOIN_MAINNET_PARAMS);
    expect(addr.scriptType).toBe(UtxoScriptTypes.P2WPKH);
  });

  it('accepts a P2TR (bech32m) address', () => {
    const addr = new BtcAddress(MAINNET_P2TR, BITCOIN_MAINNET_PARAMS);
    expect(addr.scriptType).toBe(UtxoScriptTypes.P2TR);
  });

  it('rejects a testnet address on mainnet params', () => {
    expect(() => new BtcAddress(TESTNET_P2WPKH, BITCOIN_MAINNET_PARAMS)).toThrow(/Btc/);
  });

  it('rejects empty / non-string inputs', () => {
    expect(() => new BtcAddress('', BITCOIN_MAINNET_PARAMS)).toThrow();
    expect(() => new BtcAddress('not-an-address', BITCOIN_MAINNET_PARAMS)).toThrow();
  });
});

describe('BtcAddress — testnet/regtest', () => {
  it('accepts a testnet bech32 address with testnet params', () => {
    const addr = new BtcAddress(TESTNET_P2WPKH, BITCOIN_TESTNET_PARAMS);
    expect(addr.scriptType).toBe(UtxoScriptTypes.P2WPKH);
  });

  it('rejects a mainnet address on testnet params', () => {
    expect(() => new BtcAddress(MAINNET_P2WPKH, BITCOIN_TESTNET_PARAMS)).toThrow();
  });

  it('accepts a regtest bech32 address with regtest params', () => {
    const addr = new BtcAddress(REGTEST_P2WPKH, BITCOIN_REGTEST_PARAMS);
    expect(addr.scriptType).toBe(UtxoScriptTypes.P2WPKH);
  });

  it('rejects a regtest address on testnet params (different HRP)', () => {
    expect(() => new BtcAddress(REGTEST_P2WPKH, BITCOIN_TESTNET_PARAMS)).toThrow();
  });
});
