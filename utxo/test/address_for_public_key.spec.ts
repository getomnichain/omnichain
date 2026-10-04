import { payments } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { UtxoScriptTypes, UtxoSingleKeyScriptType } from '../script.ts';
import { UtxoChain } from '../utxo_chain.ts';
import { UtxoCoin } from '../utxo_chains.ts';

import { TestKey, offlineChain } from './multisigner_helpers.ts';

const key = TestKey.fromByte(0x11);

function chainError(run: () => unknown): { kind: string; message: string } {
  try {
    run();
  } catch (err) {
    if (isChainError(err)) return err;
    throw err;
  }
  throw new Error('expected a ChainError');
}

describe('UtxoChain.addressForPublicKey', () => {
  it.each([
    ['Bitcoin', UtxoCoin.Bitcoin, 'bc1q'],
    ['Bitcoin testnet', UtxoCoin.BitcoinTestnet, 'tb1q'],
    ['Litecoin', UtxoCoin.Litecoin, 'ltc1q'],
  ])('derives the P2WPKH address by default on %s', (_label, coin, prefix) => {
    const chain = offlineChain(coin);

    const address = chain.addressForPublicKey(key.publicKey);

    expect(address).toBe(payments.p2wpkh({ pubkey: key.publicKey, network: chain.params.networkInfo }).address);
    expect(address.startsWith(prefix)).toBe(true);
    expect(chain.validateAddress(address)).toBe(true);
  });

  it.each([
    ['Bitcoin', UtxoCoin.Bitcoin],
    ['Bitcoin testnet', UtxoCoin.BitcoinTestnet],
    ['Litecoin', UtxoCoin.Litecoin],
    ['Dogecoin', UtxoCoin.Dogecoin],
  ])('derives the P2PKH address on %s', (_label, coin) => {
    const chain = offlineChain(coin);

    const address = chain.addressForPublicKey(key.publicKey, UtxoScriptTypes.P2PKH);

    expect(address).toBe(payments.p2pkh({ pubkey: key.publicKey, network: chain.params.networkInfo }).address);
    expect(chain.validateAddress(address)).toBe(true);
  });

  it('reports P2WPKH on Dogecoin as not supported', () => {
    const chain: UtxoChain = offlineChain(UtxoCoin.Dogecoin);

    const err = chainError(() => chain.addressForPublicKey(key.publicKey));

    expect(err.kind).toBe(ChainErrorKinds.FeatureNotSupported);
    expect(err.message).toContain("use scriptType 'p2pkh'");
  });

  it.each([
    ['empty', new Uint8Array(0)],
    ['uncompressed', ecc.pointFromScalar(key.privateKey, false)!],
    ['33 bytes but not a point', Uint8Array.from([0x05, ...new Uint8Array(32).fill(0xff)])],
    ['not a byte array', 'public-key' as unknown as Uint8Array],
  ])('rejects a public key that is %s', (_label, publicKey) => {
    const err = chainError(() => offlineChain().addressForPublicKey(publicKey));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('33-byte compressed secp256k1 public key');
  });

  it.each([UtxoScriptTypes.P2TR, UtxoScriptTypes.P2SH, UtxoScriptTypes.P2WSH])(
    'rejects script type %s',
    (scriptType) => {
      const err = chainError(() =>
        offlineChain().addressForPublicKey(key.publicKey, scriptType as unknown as UtxoSingleKeyScriptType),
      );

      expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
      expect(err.message).toContain(`got ${scriptType}`);
    },
  );
});
