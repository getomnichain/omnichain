import { Keypair, Networks } from '@stellar/stellar-sdk';

import { CHAIN_ID_STELLAR_MAINNET } from '../../chain_ids.ts';
import { ChainType, WalletFamily } from '../../chain_type.ts';
import { STELLAR_BNUSD, STELLAR_TESTNET_XLM, STELLAR_USDC, STELLAR_XLM } from '../stellar_assets.ts';
import { StellarAsset } from '../stellar_asset.ts';
import { StellarChain, StellarSignedMessage } from '../stellar_chain.ts';
import { StellarWallet } from '../stellar_wallet.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RAW_MESSAGE = 'Hello World!';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function sac(code: string, issuer: string): StellarAsset {
  return new StellarAsset({ chainId: CHAIN_ID_STELLAR_MAINNET, networkPassphrase: Networks.PUBLIC, code, issuer });
}

describe('StellarAsset equality (Python TestStellarAssetEquality)', () => {
  it('native XLM on the same chain is equal', () => {
    const a = new StellarAsset({ chainId: CHAIN_ID_STELLAR_MAINNET, networkPassphrase: Networks.PUBLIC, code: 'XLM', issuer: null });
    const b = new StellarAsset({ chainId: CHAIN_ID_STELLAR_MAINNET, networkPassphrase: Networks.PUBLIC, code: 'XLM', issuer: null });
    expect(a.equals(b)).toBe(true);
    expect(a.strictEquals(b)).toBe(true);
  });

  it('SAC assets with same code and issuer are equal', () => {
    expect(sac('USDC', USDC_ISSUER).equals(sac('USDC', USDC_ISSUER))).toBe(true);
  });

  it('SAC assets with a different code are not equal', () => {
    expect(sac('USDC', USDC_ISSUER).equals(sac('FOO', USDC_ISSUER))).toBe(false);
  });

  it('SAC assets with a different issuer are not equal', () => {
    expect(sac('USDC', USDC_ISSUER).equals(sac('USDC', Keypair.random().publicKey()))).toBe(false);
  });

  it('mainnet XLM and testnet XLM are not equal', () => {
    expect(STELLAR_XLM.equals(STELLAR_TESTNET_XLM)).toBe(false);
  });
});

describe('StellarAsset shapes', () => {
  it('native XLM resolves to the network native contract id with 7 decimals', () => {
    expect(STELLAR_XLM.isNative()).toBe(true);
    expect(STELLAR_XLM.identifier).toBe(StellarAsset.PUBLIC_NATIVE_CONTRACT_ID);
    expect(STELLAR_TESTNET_XLM.identifier).toBe(StellarAsset.TESTNET_NATIVE_CONTRACT_ID);
    expect(STELLAR_XLM.decimals).toBe(7);
  });

  it('SAC derives its contract id from code + issuer + network', () => {
    expect(STELLAR_USDC.isSac()).toBe(true);
    expect(STELLAR_USDC.contractId).toBe('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75');
    expect(STELLAR_USDC.decimals).toBe(7);
  });

  it('non-SAC Soroban token keeps its contract id and decimals', () => {
    expect(STELLAR_BNUSD.isNonSacSorobanToken()).toBe(true);
    expect(STELLAR_BNUSD.decimals).toBe(18);
    expect(() => STELLAR_BNUSD.toSdkAsset()).toThrow(/non-SAC/);
  });

  it('rejects an invalid issuer, a wrong SAC contract id, wrong decimals and a non-XLM native code', () => {
    expect(() => sac('USDC', 'GNOTANISSUER')).toThrow(/issuer/);
    expect(
      () =>
        new StellarAsset({
          chainId: CHAIN_ID_STELLAR_MAINNET,
          networkPassphrase: Networks.PUBLIC,
          code: 'USDC',
          issuer: USDC_ISSUER,
          contractId: STELLAR_BNUSD.contractId,
        }),
    ).toThrow(/Invalid contract id/);
    expect(
      () =>
        new StellarAsset({ chainId: CHAIN_ID_STELLAR_MAINNET, networkPassphrase: Networks.PUBLIC, code: 'USDC', issuer: USDC_ISSUER, decimals: 6 }),
    ).toThrow(/decimals/);
    expect(
      () => new StellarAsset({ chainId: CHAIN_ID_STELLAR_MAINNET, networkPassphrase: Networks.PUBLIC, code: 'BTC', issuer: null }),
    ).toThrow(/native asset/);
    expect(
      () =>
        new StellarAsset({
          chainId: CHAIN_ID_STELLAR_MAINNET,
          networkPassphrase: Networks.PUBLIC,
          code: 'TKN',
          issuer: null,
          contractId: STELLAR_BNUSD.contractId,
        }),
    ).toThrow(/decimals/);
    expect(() => new StellarAsset({ chainId: 1, networkPassphrase: 'other', code: 'XLM', issuer: null })).toThrow(/not supported/);
  });
});

describe('StellarWallet derivation (Python TestStellarWalletGenerationMnemonic)', () => {
  it.each([
    ["m/44'/148'/0'", 'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX'],
    ["m/44'/148'/1'", 'GDVSYYTUAJ3ACHTPQNSTQBDQ4LDHQCMNY4FCEQH5TJUMSSLWQSTG42MV'],
  ])('%s -> %s', (path, expected) => {
    expect(StellarWallet.fromMnemonic(MNEMONIC, path).address).toBe(expected);
  });

  it('default derivation path is account 0', () => {
    expect(StellarWallet.fromMnemonic(MNEMONIC).address).toBe('GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX');
  });

  it('python-mnemonic semantics: exact single-space English, checksum enforced', () => {
    expect(() => StellarWallet.fromMnemonic(MNEMONIC.replace('about', 'abandon'))).toThrow(/Invalid mnemonic/);
    expect(() => StellarWallet.fromMnemonic(MNEMONIC.toUpperCase())).toThrow(/Invalid mnemonic/);
    expect(() => StellarWallet.fromMnemonic(MNEMONIC.replace(' ', '  '))).toThrow(/Invalid mnemonic/);
  });

  it('passphrase changes the derived account', () => {
    expect(StellarWallet.fromMnemonic(MNEMONIC, "m/44'/148'/0'", 'secret').address).not.toBe(
      'GB3JDWCQJCWMJ3IILWIGDTQJJC5567PGVEVXSCVPEQOTDN64VJBDQBYX',
    );
  });

  it.each(["m/44'/148'/0'/0'", "m/44'/148'/0", "m/44'/60'/0'"])('rejects derivation path %s', (path) => {
    expect(() => StellarWallet.fromMnemonic(MNEMONIC, path)).toThrow(/derivation path/);
  });

  it('derivationPath() enforces SLIP-0010 hardened-only m/44\'/148\'/account\'', () => {
    expect(StellarWallet.derivationPath()).toBe("m/44'/148'/0'");
    expect(StellarWallet.derivationPath({ account: 7 })).toBe("m/44'/148'/7'");
    expect(() => StellarWallet.derivationPath({ change: 1 })).toThrow(/change/);
    expect(() => StellarWallet.derivationPath({ index: 1 })).toThrow(/index/);
    expect(() => StellarWallet.derivationPath({ coinType: 60 })).toThrow(/coin_type/);
  });

  it('constructs from a secret seed and never echoes it in errors', () => {
    const wallet = StellarWallet.fromMnemonic(MNEMONIC);
    expect(StellarWallet.fromSecret(wallet.secretSeed).address).toBe(wallet.address);
    expect(wallet.publicKey).toBe(wallet.address);
    expect(wallet.chainType()).toBe(ChainType.STELLAR);
    expect(StellarWallet.walletFamily()).toBe(WalletFamily.STELLAR);
    const bogus = 'S' + 'A'.repeat(55);
    expect(() => new StellarWallet(bogus)).toThrow('Invalid Stellar secret seed');
    try {
      new StellarWallet(bogus);
    } catch (err) {
      expect((err as Error).message).not.toContain(bogus);
    }
  });
});

describe('StellarWallet SEP-53 signatures (Python TestStellarWalletMessageSignatureMnemonic)', () => {
  it.each([
    [
      "m/44'/148'/0'",
      '79728f5fb1600f2e0913f4374266cb3fc1fcb8386b7370a74aa8d569c45763dc97eccf47f0ffae0c207cb935f4faefc8954abcb01e353ac300b53949462ffb07',
    ],
    [
      "m/44'/148'/1'",
      'f7240563e18f48ac6a58015a74aacf0d3e337c3c0f6591e927ec0b88183e2ba9f7824bdae20d0d92101b8fc374b9a3ad2586ddabfec844a7d5d039b294045804',
    ],
  ])('%s signs "Hello World!" exactly like stellar-sdk', (path, expected) => {
    const signed = StellarWallet.fromMnemonic(MNEMONIC, path).signMessage(RAW_MESSAGE);
    expect(signed).toBeInstanceOf(StellarSignedMessage);
    expect(signed.signature).toBe(expected);
  });

  it('sign/verify round trip, tamper detection (Python TestStellarWalletSignAndVerifyMessage)', () => {
    const wallet = StellarWallet.fromMnemonic(MNEMONIC);
    const signed = wallet.signMessage(RAW_MESSAGE);
    expect(wallet.verifySignature(RAW_MESSAGE, signed)).toBe(true);
    expect(wallet.verifySignature(`${RAW_MESSAGE}!`, signed)).toBe(false);
  });

  it('StellarChain.verifySignature rejects non-hex signatures and foreign keys without throwing', () => {
    const wallet = StellarWallet.fromMnemonic(MNEMONIC);
    const signed = wallet.signMessage(RAW_MESSAGE);
    expect(StellarChain.verifySignature(Keypair.random().publicKey(), RAW_MESSAGE, signed)).toBe(false);
    expect(StellarChain.verifySignature(wallet.address, RAW_MESSAGE, new StellarSignedMessage('zz'))).toBe(false);
    expect(StellarChain.verifySignature('not-a-key', RAW_MESSAGE, signed)).toBe(false);
  });
});
