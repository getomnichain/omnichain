import { bitcoinTestnetChain } from '../btc_chains.ts';
import { Priority } from '../../../priority.ts';
import { UtxoChain } from '../../utxo_chain.ts';
import { FeeEstimate } from '../../utxo.ts';

const CHAIN_ID = -2;

function stubFeeEstimator(satsPerVByte: number): { tool: any; spy: jest.Mock } {
  const spy = jest.fn(
    async (_targetBlocks: number): Promise<FeeEstimate> => ({ satsPerVByte }),
  );
  const tool: any = {
    name: 'stub',
    getUtxos: jest.fn(),
    getAddressBalance: jest.fn(),
    getRawTransactionHex: jest.fn(),
    getRawTransactionHexBatch: jest.fn(),
    getTransaction: jest.fn(),
    getFeeEstimate: spy,
    broadcast: jest.fn(),
    getChainTipHeight: jest.fn(),
  };
  return { tool, spy };
}

describe('UtxoChain.targetBlocksForPriority', () => {
  it('FAST=1, NORMAL=3, SLOW=6', () => {
    expect(UtxoChain.targetBlocksForPriority(Priority.FAST)).toBe(1);
    expect(UtxoChain.targetBlocksForPriority(Priority.NORMAL)).toBe(3);
    expect(UtxoChain.targetBlocksForPriority(Priority.SLOW)).toBe(6);
  });
});

describe('UtxoChain.suggestFeeRate', () => {
  it('passes the priority-mapped targetBlocks to the wired fee estimator', async () => {
    const { tool, spy } = stubFeeEstimator(42);
    const chain = bitcoinTestnetChain({
      chainId: CHAIN_ID,
      utxoProvider: tool,
      rawTxProvider: tool,
      feeEstimator: tool,
      broadcaster: tool,
      chainTipProvider: tool,
    });

    await chain.suggestFeeRate(Priority.FAST);
    await chain.suggestFeeRate(Priority.NORMAL);
    await chain.suggestFeeRate(Priority.SLOW);

    expect(spy).toHaveBeenNthCalledWith(1, 1);
    expect(spy).toHaveBeenNthCalledWith(2, 3);
    expect(spy).toHaveBeenNthCalledWith(3, 6);
  });

  it('returns the satsPerVByte reported by the fee estimator', async () => {
    const { tool } = stubFeeEstimator(17);
    const chain = bitcoinTestnetChain({
      chainId: CHAIN_ID,
      utxoProvider: tool,
      rawTxProvider: tool,
      feeEstimator: tool,
      broadcaster: tool,
      chainTipProvider: tool,
    });

    expect(await chain.suggestFeeRate(Priority.NORMAL)).toBe(17);
  });
});
