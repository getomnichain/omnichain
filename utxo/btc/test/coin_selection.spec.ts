import { CoinSelectionOutcomes, selectCoins } from '../../coin_selection.ts';
import { outputVBytes } from '../../fee.ts';
import { UtxoScriptTypes } from '../../script.ts';
import { UnspentTransactionOutput } from '../../utxo.ts';

function utxo(valueSats: number, vout = 0): UnspentTransactionOutput {
  return {
    txid: `tx${vout}`,
    vout,
    valueSats,
    scriptPubKeyHex: '00',
    scriptType: UtxoScriptTypes.P2WPKH,
    confirmations: 6,
    ownerAddress: 'bc1qaddr',
  };
}

describe('selectCoins', () => {
  const feeRate = 10;
  const outputsFixedVBytes = outputVBytes(UtxoScriptTypes.P2WPKH);

  it('returns InsufficientFunds when effective value is below target', () => {
    const result = selectCoins({
      utxos: [utxo(700)],
      targetSats: 100_000,
      feeRateSatsPerVByte: feeRate,
      changeOutputType: UtxoScriptTypes.P2WPKH,
      outputsFixedVBytes,
      costOfChangeSats: 1_000,
    });
    expect(result.outcome).toBe(CoinSelectionOutcomes.InsufficientFunds);
  });

  it('picks a single UTXO when one is enough and emits a change output', () => {
    const result = selectCoins({
      utxos: [utxo(100_000, 0), utxo(50_000, 1)],
      targetSats: 30_000,
      feeRateSatsPerVByte: feeRate,
      changeOutputType: UtxoScriptTypes.P2WPKH,
      outputsFixedVBytes,
      costOfChangeSats: 1_000,
    });
    expect(result.outcome).toBe(CoinSelectionOutcomes.Success);
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].valueSats).toBe(100_000);
    expect(result.hasChange).toBe(true);
    expect(result.totalValueSats).toBe(100_000);
    expect(result.changeSats).toBeGreaterThan(0);
    expect(result.totalValueSats - 30_000 - result.changeSats).toBe(result.feeSats);
  });

  it('absorbs change into fees when change would be below dust', () => {
    const result = selectCoins({
      utxos: [utxo(31_400)],
      targetSats: 30_000,
      feeRateSatsPerVByte: feeRate,
      changeOutputType: UtxoScriptTypes.P2WPKH,
      outputsFixedVBytes,
      costOfChangeSats: 50_000,
    });
    expect(result.outcome).toBe(CoinSelectionOutcomes.Success);
    expect(result.hasChange).toBe(false);
    expect(result.changeSats).toBe(0);
  });

  it('combines multiple UTXOs when no single one suffices', () => {
    const result = selectCoins({
      utxos: [utxo(30_000, 0), utxo(20_000, 1), utxo(40_000, 2)],
      targetSats: 60_000,
      feeRateSatsPerVByte: feeRate,
      changeOutputType: UtxoScriptTypes.P2WPKH,
      outputsFixedVBytes,
      costOfChangeSats: 1_000,
    });
    expect(result.outcome).toBe(CoinSelectionOutcomes.Success);
    expect(result.selected.length).toBeGreaterThanOrEqual(2);
    expect(result.totalValueSats).toBeGreaterThanOrEqual(60_000);
  });

  it('NoSolution when target is non-positive', () => {
    const result = selectCoins({
      utxos: [utxo(100_000)],
      targetSats: 0,
      feeRateSatsPerVByte: feeRate,
      changeOutputType: UtxoScriptTypes.P2WPKH,
      outputsFixedVBytes,
      costOfChangeSats: 1_000,
    });
    expect(result.outcome).toBe(CoinSelectionOutcomes.NoSolution);
  });
});
