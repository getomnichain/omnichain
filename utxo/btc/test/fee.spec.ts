import {
  effectiveValueSats,
  estimateTxVBytes,
  feeForVBytes,
  inputVBytes,
  outputVBytes,
} from '../../fee.ts';
import { UtxoScriptTypes } from '../../script.ts';

describe('fee math', () => {
  it('per-type input vBytes match the handoff', () => {
    expect(inputVBytes(UtxoScriptTypes.P2PKH)).toBe(148);
    expect(inputVBytes(UtxoScriptTypes.P2SH)).toBe(91);
    expect(inputVBytes(UtxoScriptTypes.P2WPKH)).toBe(68);
    expect(inputVBytes(UtxoScriptTypes.P2TR)).toBe(57.5);
  });

  it('per-type output vBytes match the handoff', () => {
    expect(outputVBytes(UtxoScriptTypes.P2PKH)).toBe(34);
    expect(outputVBytes(UtxoScriptTypes.P2WPKH)).toBe(31);
    expect(outputVBytes(UtxoScriptTypes.P2TR)).toBe(43);
  });

  it('estimateTxVBytes for 1-in 2-out P2WPKH ≈ 141 vBytes', () => {
    const v = estimateTxVBytes(
      [UtxoScriptTypes.P2WPKH],
      [UtxoScriptTypes.P2WPKH, UtxoScriptTypes.P2WPKH]
    );
    expect(v).toBeGreaterThanOrEqual(140);
    expect(v).toBeLessThanOrEqual(142);
  });

  it('estimateTxVBytes for 1-in 1-out P2WPKH ≈ 110 vBytes', () => {
    const v = estimateTxVBytes([UtxoScriptTypes.P2WPKH], [UtxoScriptTypes.P2WPKH]);
    expect(v).toBeGreaterThanOrEqual(109);
    expect(v).toBeLessThanOrEqual(111);
  });

  it('feeForVBytes rounds up', () => {
    expect(feeForVBytes(141, 10)).toBe(1410);
    expect(feeForVBytes(57.5, 10)).toBe(575);
    expect(feeForVBytes(57.5, 3)).toBe(173);
  });

  it('effectiveValueSats subtracts input cost at the given fee rate', () => {
    expect(effectiveValueSats(1_000, UtxoScriptTypes.P2WPKH, 10)).toBe(1_000 - 680);
    expect(effectiveValueSats(700, UtxoScriptTypes.P2WPKH, 10)).toBe(20);
  });
});
