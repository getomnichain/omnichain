import { payments } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

import { isByteArray } from './bytes.ts';
import { UtxoScriptTypes, UtxoSingleKeyScriptType } from './script.ts';
import { UtxoNetworkInfo } from './utxo_network_params.ts';

export const COMPACT_SIGNATURE_BYTES = 64;

export function isCompressedPublicKey(publicKey: unknown): publicKey is Uint8Array {
  return isByteArray(publicKey) && ecc.isPointCompressed(publicKey);
}

export function singleKeyPayment(
  publicKey: Uint8Array,
  scriptType: UtxoSingleKeyScriptType,
  network: UtxoNetworkInfo,
): payments.Payment {
  return scriptType === UtxoScriptTypes.P2WPKH
    ? payments.p2wpkh({ pubkey: publicKey, network })
    : payments.p2pkh({ pubkey: publicKey, network });
}

export function verifyStrictSignature(
  publicKey: Uint8Array,
  hash: Uint8Array,
  signature: Uint8Array,
): boolean {
  return ecc.verify(hash, publicKey, signature, true);
}
