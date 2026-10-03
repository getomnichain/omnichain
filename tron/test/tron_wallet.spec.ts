import { CHAIN_ID_TRON_MAINNET } from '../../chain_ids.ts';
import { ChainType, WalletFamily } from '../../chain_type.ts';
import { TRON_SHASTA_TRX, TRON_TRX } from '../tron_assets.ts';
import { TronAsset } from '../tron_asset.ts';
import { TronChain, TronSignedMessage } from '../tron_chain.ts';
import { TronPublicKey } from '../tron_keys.ts';
import { TronWallet } from '../tron_wallet.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RAW_MESSAGE = 'Hello World!';

describe('TronAsset equality (Python TestTronAssetEquality)', () => {
  it('native TRX on the same chain is equal', () => {
    const a = new TronAsset(CHAIN_ID_TRON_MAINNET, 'TRX', null, TronAsset.NATIVE_DECIMALS);
    const b = new TronAsset(CHAIN_ID_TRON_MAINNET, 'TRX', null, TronAsset.NATIVE_DECIMALS);
    expect(a.equals(b)).toBe(true);
    expect(a.strictEquals(b)).toBe(true);
  });

  it('TRC-20 with same symbol and contract is equal', () => {
    const a = new TronAsset(CHAIN_ID_TRON_MAINNET, 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);
    const b = new TronAsset(CHAIN_ID_TRON_MAINNET, 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);
    expect(a.equals(b)).toBe(true);
  });

  it('TRC-20 with a different symbol is not equal', () => {
    const a = new TronAsset(CHAIN_ID_TRON_MAINNET, 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);
    const b = new TronAsset(CHAIN_ID_TRON_MAINNET, 'FOO', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);
    expect(a.equals(b)).toBe(false);
  });

  it('TRC-20 with a different contract is not equal', () => {
    const a = new TronAsset(CHAIN_ID_TRON_MAINNET, 'USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);
    const b = new TronAsset(CHAIN_ID_TRON_MAINNET, 'USDT', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 6);
    expect(a.equals(b)).toBe(false);
  });

  it('mainnet TRX and Shasta TRX are not equal', () => {
    expect(TRON_TRX.equals(TRON_SHASTA_TRX)).toBe(false);
  });
});

describe('TronWallet derivation (Python TestTronWalletGeneration)', () => {
  it.each([
    ["m/44'/195'/0'/0/0", 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'],
    ["m/44'/195'/0'/0/1", 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK'],
    ["m/44'/195'/1'/0/0", 'TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4'],
    ["m/44'/195'/1'/0/1", 'TUT9qMmtJtnjJhpazPaLraWSTaThhBpWyR'],
  ])('%s -> %s', (path, expected) => {
    expect(TronWallet.fromMnemonic(MNEMONIC, path).address).toBe(expected);
  });

  it('default path is m/44\'/195\'/0\'/0/0', () => {
    expect(TronWallet.fromMnemonic(MNEMONIC).address).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  });

  it('mnemonic parsing lowercases and tolerates extra whitespace (bip_utils semantics)', () => {
    expect(TronWallet.fromMnemonic(`  ${MNEMONIC.toUpperCase().replace(/ /g, '   ')} `).address).toBe(
      'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
    );
  });

  it('rejects a mnemonic with a bad checksum', () => {
    expect(() => TronWallet.fromMnemonic(MNEMONIC.replace('about', 'abandon'))).toThrow(/checksum/i);
  });

  it.each(["m/44'/60'/0'/0/0", "m/49'/195'/0'/0/0", "m/44'/195'/0/0/0", 'garbage'])('rejects derivation path %s', (path) => {
    expect(() => TronWallet.fromMnemonic(MNEMONIC, path)).toThrow(/derivation path/);
  });

  it('derivationPath() builds the BIP44 path and enforces purpose/coin type', () => {
    expect(TronWallet.derivationPath()).toBe("m/44'/195'/0'/0/0");
    expect(TronWallet.derivationPath({ account: 1, change: 0, index: 3 })).toBe("m/44'/195'/1'/0/3");
    expect(() => TronWallet.derivationPath({ purpose: 49 })).toThrow();
    expect(() => TronWallet.derivationPath({ coinType: 60 })).toThrow();
  });

  it('accepts a 0x-prefixed private key and exposes chain metadata', () => {
    const wallet = TronWallet.fromMnemonic(MNEMONIC);
    const prefixed = new TronWallet(`0x${wallet.privateKeyHex}`);
    expect(prefixed.address).toBe(wallet.address);
    expect(prefixed.chainType()).toBe(ChainType.TRON);
    expect(TronWallet.walletFamily()).toBe(WalletFamily.TRON);
  });
});

describe('TronWallet message signatures (Python TestTronWalletMessageSignature)', () => {
  it.each([
    [
      "m/44'/195'/0'/0/0",
      '9d5111010d5501d27d8ad4a81f7c338f3677327e2e3cc66b83f7c0c9e24e334a30c26d3d05e73f1193b6246b857ba65dde31db565a865fefe56fbe667ea9dfcf01',
    ],
    [
      "m/44'/195'/0'/0/1",
      '006839bb1585822183a54ff58aff446720b877324f9d6727e6461a672bf5bcc14f47d50e86f127ed573e9c667db2aea9347cde0969fb3efca4d6ec149b9baa2700',
    ],
    [
      "m/44'/195'/1'/0/0",
      '7a8e71d3807bcf80a51ad8f5a963de3739d7eee6841abad794722ba99805e5300cb30bd05732ee70f88707d05fde33183d807104175fde41fbc5b3fba1fbb3cb00',
    ],
    [
      "m/44'/195'/1'/0/1",
      '1dc3ba529e94bea2cda72054f840b7f81d7a7c8fba536c4f199e9db8986c24e06dea71e37d7c163e52f36c9e58fa62800c3f541e3d58ed37dc4f6f1f1ae40d6800',
    ],
  ])('%s signs "Hello World!" exactly like tronpy', (path, expected) => {
    const signed = TronWallet.fromMnemonic(MNEMONIC, path).signMessage(RAW_MESSAGE);
    expect(signed).toBeInstanceOf(TronSignedMessage);
    expect(signed.signature).toBe(expected);
  });

  it('verifies its own signature and rejects a tampered message', () => {
    const wallet = TronWallet.fromMnemonic(MNEMONIC);
    const signed = wallet.signMessage(RAW_MESSAGE);
    expect(wallet.verifySignature(RAW_MESSAGE, signed)).toBe(true);
    expect(wallet.verifySignature(`${RAW_MESSAGE}!`, signed)).toBe(false);
  });

  it('TronChain.verifySignature accepts the 64-byte public key hex, with or without 0x', () => {
    const wallet = TronWallet.fromMnemonic(MNEMONIC);
    const signed = wallet.signMessage(RAW_MESSAGE);
    expect(TronChain.verifySignature(wallet.publicKey.hex(), RAW_MESSAGE, signed)).toBe(true);
    expect(TronChain.verifySignature(`0x${wallet.publicKey.hex()}`, RAW_MESSAGE, signed)).toBe(true);
    expect(TronChain.verifySignature(TronPublicKey.fromHex(wallet.publicKey.hex()), RAW_MESSAGE, signed)).toBe(true);
    expect(TronChain.verifySignature('00', RAW_MESSAGE, signed)).toBe(false);
  });

  it('verification ignores v, like tronpy (v flipped still verifies)', () => {
    const wallet = TronWallet.fromMnemonic(MNEMONIC);
    const signed = wallet.signMessage(RAW_MESSAGE);
    const flipped = signed.signature.slice(0, 128) + (signed.signature.endsWith('00') ? '01' : '00');
    expect(TronChain.verifySignature(wallet.publicKey, RAW_MESSAGE, new TronSignedMessage(flipped))).toBe(true);
  });
});
