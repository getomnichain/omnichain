import { jest } from '@jest/globals';
import { PublicKey } from '@solana/web3.js';

import { SolanaMainnet } from '../solana_chains.ts';

// getTransaction returns a rich object; we synthesize just enough for decoder.
type FakeTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string | null;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null; uiAmountString: string };
};

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ALICE = '5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4';
const BOB = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const CHARLIE = 'BbmkgZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM9WzDXwB';

function fakeTx(opts: {
  slot: number;
  blockTime: number | null;
  err: unknown;
  fee: number;
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: FakeTokenBalance[];
  postTokenBalances: FakeTokenBalance[];
}): unknown {
  return {
    slot: opts.slot,
    blockTime: opts.blockTime,
    transaction: {
      message: {
        staticAccountKeys: opts.accountKeys.map((k) => new PublicKey(k)),
      },
      signatures: ['sig'],
    },
    meta: {
      err: opts.err,
      fee: opts.fee,
      preBalances: opts.preBalances,
      postBalances: opts.postBalances,
      preTokenBalances: opts.preTokenBalances,
      postTokenBalances: opts.postTokenBalances,
      innerInstructions: [],
      logMessages: [],
    },
  };
}

describe('SolanaChain.decodeBalanceChanges (via getTransactionStatus)', () => {
  const chain = SolanaMainnet;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockGetTransaction(tx: unknown) {
    const conn = chain.getConnection();
    jest.spyOn(conn, 'getTransaction').mockResolvedValue(tx as never);
    jest.spyOn(conn, 'getSlot').mockResolvedValue(1_000);
  }

  it('SPL balance change: uses uiTokenAmount.decimals (not 0) and owner (not mint)', async () => {
    mockGetTransaction(
      fakeTx({
        slot: 500,
        blockTime: 1_700_000_000,
        err: null,
        fee: 5000,
        accountKeys: [ALICE, BOB, USDC_MINT],
        preBalances: [1_000_000_000, 0, 0],
        postBalances: [999_995_000, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 0,
            mint: USDC_MINT,
            owner: ALICE,
            uiTokenAmount: { amount: '10000000', decimals: 6, uiAmount: 10, uiAmountString: '10' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint: USDC_MINT,
            owner: ALICE,
            uiTokenAmount: { amount: '9000000', decimals: 6, uiAmount: 9, uiAmountString: '9' },
          },
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: BOB,
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' },
          },
        ],
      }),
    );

    const status = await chain.getTransactionStatus('sig');
    const splChanges = status.balanceChanges.filter((c) => c.token.identifier === USDC_MINT);
    expect(splChanges).toHaveLength(2);

    const alicePair = splChanges.find((c) => c.address === ALICE);
    const bobPair = splChanges.find((c) => c.address === BOB);
    expect(alicePair).toBeDefined();
    expect(bobPair).toBeDefined();
    expect(alicePair!.amount).toBe(-1_000_000n);
    expect(bobPair!.amount).toBe(1_000_000n);
    // Decimals now come from uiTokenAmount, not the hardcoded 0.
    expect(alicePair!.token.decimals).toBe(6);
    expect(bobPair!.token.decimals).toBe(6);
    // Address is the owner (a wallet), never the mint.
    expect(alicePair!.address).not.toBe(USDC_MINT);
    expect(bobPair!.address).not.toBe(USDC_MINT);
  });

  it('SPL balance change with null owner is dropped (was filling in mint as address)', async () => {
    mockGetTransaction(
      fakeTx({
        slot: 500,
        blockTime: 1_700_000_000,
        err: null,
        fee: 5000,
        accountKeys: [ALICE, CHARLIE, USDC_MINT],
        preBalances: [1_000_000_000, 0, 0],
        postBalances: [999_995_000, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: null,
            uiTokenAmount: { amount: '5000000', decimals: 6, uiAmount: 5, uiAmountString: '5' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: null,
            uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
          },
        ],
      }),
    );

    const status = await chain.getTransactionStatus('sig');
    const splChanges = status.balanceChanges.filter((c) => c.token.identifier === USDC_MINT);
    // The single ownerless entry is skipped — never emits the mint as a wallet.
    expect(splChanges).toHaveLength(0);
    // And critically, no change carries the mint address as `address`.
    for (const c of status.balanceChanges) {
      expect(c.address).not.toBe(USDC_MINT);
    }
  });

  it('null owner in pre but set in post is preserved (freshly-initialized ATA)', async () => {
    mockGetTransaction(
      fakeTx({
        slot: 500,
        blockTime: 1_700_000_000,
        err: null,
        fee: 5000,
        accountKeys: [ALICE, BOB, USDC_MINT],
        preBalances: [1_000_000_000, 0, 0],
        postBalances: [999_995_000, 0, 0],
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: BOB,
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1, uiAmountString: '1' },
          },
        ],
      }),
    );

    const status = await chain.getTransactionStatus('sig');
    const bobChange = status.balanceChanges.find(
      (c) => c.token.identifier === USDC_MINT && c.address === BOB,
    );
    expect(bobChange).toBeDefined();
    expect(bobChange!.amount).toBe(1_000_000n);
    expect(bobChange!.token.decimals).toBe(6);
  });
});
