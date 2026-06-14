import { effectiveValueSats, inputVBytes } from './fee.ts';
import { UtxoScriptType, UtxoScriptTypes } from './script.ts';
import { UnspentTransactionOutput } from './utxo.ts';

export interface CoinSelectionParams {
  utxos: readonly UnspentTransactionOutput[];
  targetSats: number;
  feeRateSatsPerVByte: number;
  longTermFeeRateSatsPerVByte?: number;
  changeOutputType: UtxoScriptType;
  outputsFixedVBytes: number;
  costOfChangeSats: number;
  maxIterations?: number;
}

export const CoinSelectionOutcomes = {
  Success: 'success',
  InsufficientFunds: 'insufficient_funds',
  NoSolution: 'no_solution',
} as const;

export type CoinSelectionOutcome =
  (typeof CoinSelectionOutcomes)[keyof typeof CoinSelectionOutcomes];

export interface CoinSelectionResult {
  outcome: CoinSelectionOutcome;
  selected: UnspentTransactionOutput[];
  totalValueSats: number;
  feeSats: number;
  changeSats: number;
  hasChange: boolean;
  algorithm: 'bnb' | 'accumulator' | null;
}

interface InputCoin {
  utxo: UnspentTransactionOutput;
  rawValue: number;
  effectiveValue: number;
  inputCost: number;
}

const DEFAULT_MAX_ITERATIONS = 100_000;

export function selectCoins(params: CoinSelectionParams): CoinSelectionResult {
  const {
    utxos,
    targetSats,
    feeRateSatsPerVByte,
    changeOutputType,
    outputsFixedVBytes,
    costOfChangeSats,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = params;

  if (targetSats <= 0) {
    return emptyResult(CoinSelectionOutcomes.NoSolution);
  }

  const coins: InputCoin[] = utxos.map((utxo) => {
    const inputCost = Math.ceil(inputVBytes(utxo.scriptType) * feeRateSatsPerVByte);
    return {
      utxo,
      rawValue: utxo.valueSats,
      effectiveValue: effectiveValueSats(utxo.valueSats, utxo.scriptType, feeRateSatsPerVByte),
      inputCost,
    };
  });

  const positiveCoins = coins.filter((c) => c.effectiveValue > 0);
  const totalEffective = positiveCoins.reduce((s, c) => s + c.effectiveValue, 0);
  if (totalEffective < targetSats) {
    return emptyResult(CoinSelectionOutcomes.InsufficientFunds);
  }

  const bnbResult = branchAndBound(positiveCoins, targetSats, costOfChangeSats, maxIterations);
  if (bnbResult) {
    return finalize(bnbResult, params, outputsFixedVBytes, feeRateSatsPerVByte, changeOutputType, 'bnb');
  }

  const accumulator = accumulatorFallback(positiveCoins, targetSats);
  if (!accumulator) {
    return emptyResult(CoinSelectionOutcomes.NoSolution);
  }
  return finalize(
    accumulator,
    params,
    outputsFixedVBytes,
    feeRateSatsPerVByte,
    changeOutputType,
    'accumulator'
  );
}

function branchAndBound(
  coins: InputCoin[],
  target: number,
  costOfChange: number,
  maxIterations: number
): InputCoin[] | null {
  const sorted = [...coins].sort((a, b) => b.effectiveValue - a.effectiveValue);
  const tail: number[] = new Array(sorted.length + 1).fill(0);
  for (let i = sorted.length - 1; i >= 0; i--) {
    tail[i] = tail[i + 1] + sorted[i].effectiveValue;
  }

  let iterations = 0;
  let best: InputCoin[] | null = null;
  let bestOver = Infinity;
  const current: InputCoin[] = [];

  function recurse(depth: number, sum: number): boolean {
    if (++iterations > maxIterations) return false;
    if (sum > target + costOfChange) return false;
    if (sum >= target) {
      const over = sum - target;
      if (over < bestOver) {
        bestOver = over;
        best = [...current];
      }
      return over === 0;
    }
    if (sum + tail[depth] < target) return false;
    if (depth === sorted.length) return false;
    current.push(sorted[depth]);
    if (recurse(depth + 1, sum + sorted[depth].effectiveValue)) {
      current.pop();
      return true;
    }
    current.pop();
    return recurse(depth + 1, sum);
  }

  recurse(0, 0);
  return best;
}

function accumulatorFallback(coins: InputCoin[], target: number): InputCoin[] | null {
  const sorted = [...coins].sort((a, b) => b.effectiveValue - a.effectiveValue);
  const selected: InputCoin[] = [];
  let sum = 0;
  for (const c of sorted) {
    selected.push(c);
    sum += c.effectiveValue;
    if (sum >= target) return selected;
  }
  return null;
}

function finalize(
  selected: InputCoin[],
  params: CoinSelectionParams,
  outputsFixedVBytes: number,
  feeRateSatsPerVByte: number,
  changeOutputType: UtxoScriptType,
  algorithm: 'bnb' | 'accumulator'
): CoinSelectionResult {
  const totalValueSats = selected.reduce((s, c) => s + c.rawValue, 0);
  const inputsVBytes = selected.reduce((s, c) => s + inputVBytes(c.utxo.scriptType), 0);

  const baseFeeSats = Math.ceil((outputsFixedVBytes + inputsVBytes) * feeRateSatsPerVByte);
  const surplusBeforeChange = totalValueSats - params.targetSats - baseFeeSats;
  if (surplusBeforeChange < 0) {
    return {
      outcome: CoinSelectionOutcomes.InsufficientFunds,
      selected: [],
      totalValueSats: 0,
      feeSats: 0,
      changeSats: 0,
      hasChange: false,
      algorithm: null,
    };
  }

  const changeOutputCost = Math.ceil(
    outputVBytesFor(changeOutputType) * feeRateSatsPerVByte
  );
  const changeIfAdded = surplusBeforeChange - changeOutputCost;
  const dustValue = params.costOfChangeSats;

  let feeSats: number;
  let changeSats: number;
  let hasChange: boolean;
  if (changeIfAdded >= dustValue) {
    hasChange = true;
    changeSats = changeIfAdded;
    feeSats = baseFeeSats + changeOutputCost;
  } else {
    hasChange = false;
    changeSats = 0;
    feeSats = baseFeeSats + surplusBeforeChange;
  }

  return {
    outcome: CoinSelectionOutcomes.Success,
    selected: selected.map((c) => c.utxo),
    totalValueSats,
    feeSats,
    changeSats,
    hasChange,
    algorithm,
  };
}

function outputVBytesFor(type: UtxoScriptType): number {
  switch (type) {
    case UtxoScriptTypes.P2PKH:
      return 34;
    case UtxoScriptTypes.P2SH:
      return 32;
    case UtxoScriptTypes.P2WPKH:
      return 31;
    case UtxoScriptTypes.P2WSH:
    case UtxoScriptTypes.P2TR:
      return 43;
    default:
      return 0;
  }
}

function emptyResult(outcome: CoinSelectionOutcome): CoinSelectionResult {
  return {
    outcome,
    selected: [],
    totalValueSats: 0,
    feeSats: 0,
    changeSats: 0,
    hasChange: false,
    algorithm: null,
  };
}
