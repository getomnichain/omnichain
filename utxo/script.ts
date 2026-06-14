import { address as bjsAddress, networks, opcodes, script as bjsScript } from 'bitcoinjs-lib';

import { OP_RETURN_MAX_BYTES } from './utxo_network_params.ts';

export const UtxoScriptTypes = {
  P2PKH: 'p2pkh',
  P2SH: 'p2sh',
  P2WPKH: 'p2wpkh',
  P2WSH: 'p2wsh',
  P2TR: 'p2tr',
  OpReturn: 'op_return',
  NonStandard: 'non_standard',
} as const;

export type UtxoScriptType = (typeof UtxoScriptTypes)[keyof typeof UtxoScriptTypes];

export function detectScriptType(script: Uint8Array): UtxoScriptType {
  const s = script;
  if (
    s.length === 25 &&
    s[0] === 0x76 &&
    s[1] === 0xa9 &&
    s[2] === 0x14 &&
    s[23] === 0x88 &&
    s[24] === 0xac
  ) {
    return UtxoScriptTypes.P2PKH;
  }
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) {
    return UtxoScriptTypes.P2SH;
  }
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) {
    return UtxoScriptTypes.P2WPKH;
  }
  if (s.length === 34 && s[0] === 0x00 && s[1] === 0x20) {
    return UtxoScriptTypes.P2WSH;
  }
  if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) {
    return UtxoScriptTypes.P2TR;
  }
  if (s.length > 0 && s[0] === 0x6a) {
    return UtxoScriptTypes.OpReturn;
  }
  return UtxoScriptTypes.NonStandard;
}

export function addressToScriptPubKey(addressStr: string, network: networks.Network): Uint8Array {
  return bjsAddress.toOutputScript(addressStr, network);
}

export function scriptTypeForAddress(addressStr: string, network: networks.Network): UtxoScriptType {
  const script = addressToScriptPubKey(addressStr, network);
  return detectScriptType(script);
}

export function buildOpReturnScript(data: Uint8Array): Uint8Array {
  if (data.length > OP_RETURN_MAX_BYTES) {
    throw new Error(
      `OP_RETURN data length ${data.length} exceeds max ${OP_RETURN_MAX_BYTES} bytes`
    );
  }
  return bjsScript.compile([opcodes.OP_RETURN, Buffer.from(data)]);
}
