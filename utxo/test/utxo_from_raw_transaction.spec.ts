import { Transaction } from 'bitcoinjs-lib';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { utxoFromRawTransaction } from '../raw_transaction.ts';
import { UtxoScriptTypes } from '../script.ts';

import { TestKey, fundingTransactionHex, offlineChain, scriptHexFor } from './multisigner_helpers.ts';

const chain = offlineChain();
const ownerAddress = chain.addressForPublicKey(TestKey.fromByte(0x11).publicKey);
const legacyAddress = chain.addressForPublicKey(TestKey.fromByte(0x22).publicKey, UtxoScriptTypes.P2PKH);
const rawTxHex = fundingTransactionHex([
  { scriptPubKeyHex: scriptHexFor(chain, ownerAddress), valueSats: 12_345 },
  { scriptPubKeyHex: scriptHexFor(chain, legacyAddress), valueSats: 67_890 },
]);

describe('utxoFromRawTransaction', () => {
  it.each([
    [0, ownerAddress, UtxoScriptTypes.P2WPKH],
    [1, legacyAddress, UtxoScriptTypes.P2PKH],
  ])('reads output %i the way bitcoinjs decodes it', (vout, owner, scriptType) => {
    const decoded = Transaction.fromHex(rawTxHex);

    expect(utxoFromRawTransaction(rawTxHex, vout, owner)).toEqual({
      txid: decoded.getId(),
      vout,
      valueSats: Number(decoded.outs[vout].value),
      scriptPubKeyHex: Buffer.from(decoded.outs[vout].script).toString('hex'),
      scriptType,
      confirmations: 0,
      ownerAddress: owner,
    });
  });

  it.each([
    ['not hex', 'zz'],
    ['empty', ''],
    ['odd-length hex', `${rawTxHex}0`],
    ['hex that is not a transaction', 'deadbeef'],
    ['a transaction followed by extra bytes', `${rawTxHex}00`],
  ])('rejects rawTxHex that is %s', (_label, hex) => {
    let caught: unknown;
    try {
      utxoFromRawTransaction(hex, 0, ownerAddress);
    } catch (err) {
      caught = err;
    }

    expect(isChainError(caught, ChainErrorKinds.InvalidArgument)).toBe(true);
    expect((caught as Error).message).toContain('rawTxHex is not a valid transaction');
  });

  it.each([2, -1, 0.5])('rejects vout %s', (vout) => {
    let caught: unknown;
    try {
      utxoFromRawTransaction(rawTxHex, vout, ownerAddress);
    } catch (err) {
      caught = err;
    }

    expect(isChainError(caught, ChainErrorKinds.InvalidArgument)).toBe(true);
    expect((caught as Error).message).toContain(`has no output ${vout} (it has 2)`);
  });
});
