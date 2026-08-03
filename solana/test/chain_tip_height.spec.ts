import { jest } from '@jest/globals';
import { SolanaChain } from '../solana_chain.ts';

function makeChain(): SolanaChain {
  return new SolanaChain({
    chainId: -1801,
    name: 'ChainTipHeightTest',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
  });
}

describe('SolanaChain.getChainTipHeight — must return block height, NOT slot (0.3.3 fix)', () => {
  it('calls getBlockHeight and returns its value', async () => {
    const chain = makeChain();
    let getSlotCalls = 0;
    let getBlockHeightCalls = 0;
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      getSlot: async () => { getSlotCalls++; return 350_000_000; },
      getBlockHeight: async () => { getBlockHeightCalls++; return 325_000_000; },
    });
    const out = await chain.getChainTipHeight();
    expect(out).toBe(325_000_000);
    expect(getBlockHeightCalls).toBe(1);
    expect(getSlotCalls).toBe(0);
  });

  it('return value is comparable with lastValidBlockHeight (both are block heights)', async () => {
    // Prior bug: getChainTipHeight returned slot (~350M), lastValidBlockHeight ~325M.
    // The check `tip > lastValidBlockHeight` was always true → every tx flagged expired.
    // With the fix, both sides are block heights; the check works.
    const chain = makeChain();
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      getBlockHeight: async () => 325_000_000,
    });
    const tip = await chain.getChainTipHeight();
    const freshLastValidBlockHeight = 325_000_150;
    expect(tip > freshLastValidBlockHeight).toBe(false);
    const staleLastValidBlockHeight = 324_999_900;
    expect(tip > staleLastValidBlockHeight).toBe(true);
  });

  it('uses confirmed commitment', async () => {
    const chain = makeChain();
    let calledWith: string | undefined;
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      getBlockHeight: async (c: string) => { calledWith = c; return 1; },
    });
    await chain.getChainTipHeight();
    expect(calledWith).toBe('confirmed');
  });
});

jest.setTimeout(10_000);
