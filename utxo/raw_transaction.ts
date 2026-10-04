import { Transaction } from 'bitcoinjs-lib';

import { ChainError, ChainErrorKinds } from '../errors.ts';

import { detectScriptType } from './script.ts';
import { UnspentTransactionOutput } from './utxo.ts';

const HEX_BYTES = /^(?:[0-9a-fA-F]{2})+$/;

export function decodeRawTransaction(rawTxHex: string): Transaction | null {
  if (typeof rawTxHex !== 'string' || !HEX_BYTES.test(rawTxHex)) return null;
  try {
    return Transaction.fromHex(rawTxHex);
  } catch {
    return null;
  }
}

export function utxoFromRawTransaction(
  rawTxHex: string,
  vout: number,
  ownerAddress: string,
): UnspentTransactionOutput {
  const tx = decodeRawTransaction(rawTxHex);
  if (tx === null) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      'utxoFromRawTransaction: rawTxHex is not a valid transaction',
    );
  }
  const txid = tx.getId();
  const output = Number.isInteger(vout) && vout >= 0 ? tx.outs[vout] : undefined;
  if (output === undefined) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `utxoFromRawTransaction: transaction ${txid} has no output ${vout} (it has ${tx.outs.length})`,
      { txHash: txid },
    );
  }
  return {
    txid,
    vout,
    valueSats: Number(output.value),
    scriptPubKeyHex: Buffer.from(output.script).toString('hex'),
    scriptType: detectScriptType(output.script),
    confirmations: 0,
    ownerAddress,
  };
}
