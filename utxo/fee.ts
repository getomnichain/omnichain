import { UtxoScriptType, UtxoScriptTypes } from './script.ts';

export const TX_OVERHEAD_VBYTES = 10.5;

export const INPUT_VBYTES: Record<UtxoScriptType, number> = {
  [UtxoScriptTypes.P2PKH]: 148,
  [UtxoScriptTypes.P2SH]: 91,
  [UtxoScriptTypes.P2WPKH]: 68,
  [UtxoScriptTypes.P2WSH]: 105,
  [UtxoScriptTypes.P2TR]: 57.5,
  [UtxoScriptTypes.OpReturn]: 0,
  [UtxoScriptTypes.NonStandard]: 0,
};

export const OUTPUT_VBYTES: Record<UtxoScriptType, number> = {
  [UtxoScriptTypes.P2PKH]: 34,
  [UtxoScriptTypes.P2SH]: 32,
  [UtxoScriptTypes.P2WPKH]: 31,
  [UtxoScriptTypes.P2WSH]: 43,
  [UtxoScriptTypes.P2TR]: 43,
  [UtxoScriptTypes.OpReturn]: 0,
  [UtxoScriptTypes.NonStandard]: 0,
};

export function inputVBytes(type: UtxoScriptType): number {
  return INPUT_VBYTES[type];
}

export function outputVBytes(type: UtxoScriptType): number {
  return OUTPUT_VBYTES[type];
}

export function opReturnOutputVBytes(dataLengthBytes: number): number {
  return Math.ceil(8 + 1 + 1 + 1 + (dataLengthBytes < 76 ? 0 : 1) + dataLengthBytes);
}

export function estimateTxVBytes(
  inputTypes: readonly UtxoScriptType[],
  outputTypes: readonly UtxoScriptType[],
  opReturnDataLengths: readonly number[] = []
): number {
  let total = TX_OVERHEAD_VBYTES;
  for (const t of inputTypes) total += inputVBytes(t);
  for (const t of outputTypes) total += outputVBytes(t);
  for (const len of opReturnDataLengths) total += opReturnOutputVBytes(len);
  return Math.ceil(total);
}

export function feeForVBytes(vBytes: number, satsPerVByte: number): number {
  return Math.ceil(vBytes * satsPerVByte);
}

export function effectiveValueSats(utxoValueSats: number, inputType: UtxoScriptType, satsPerVByte: number): number {
  return utxoValueSats - Math.ceil(inputVBytes(inputType) * satsPerVByte);
}

export function costOfChangeSats(
  changeOutputType: UtxoScriptType,
  shortTermFeeRateSatsPerVByte: number,
  longTermFeeRateSatsPerVByte: number
): number {
  const create = outputVBytes(changeOutputType) * shortTermFeeRateSatsPerVByte;
  const spend = inputVBytes(changeOutputType) * longTermFeeRateSatsPerVByte;
  return Math.ceil(create + spend);
}
