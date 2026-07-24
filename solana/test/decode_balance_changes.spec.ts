import { SolanaMainnet } from '../solana_chains.ts';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ALICE = '5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4';
const BOB = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

/**
 * Synthetic `getTransaction`-shaped object that gives `_decodeBalanceChanges` what it needs
 * without a real @solana/web3.js Connection (consumers such as pluton stub the module in
 * their jest config; a real Connection round-trip is unavailable in that env).
 */
function fakeTx(opts: {
  accountKeys: string[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: Array<{
    accountIndex: number;
    mint: string;
    owner: string | null;
    uiTokenAmount: { amount: string; decimals: number };
  }>;
  postTokenBalances: Array<{
    accountIndex: number;
    mint: string;
    owner: string | null;
    uiTokenAmount: { amount: string; decimals: number };
  }>;
}) {
  return {
    transaction: {
      message: {
        staticAccountKeys: opts.accountKeys.map((k) => ({ toBase58: () => k })),
      },
    },
    meta: {
      preBalances: opts.preBalances,
      postBalances: opts.postBalances,
      preTokenBalances: opts.preTokenBalances,
      postTokenBalances: opts.postTokenBalances,
    },
  } as unknown as Parameters<typeof SolanaMainnet._decodeBalanceChanges>[0];
}

describe('SolanaChain._decodeBalanceChanges', () => {
  it('SPL change: pulls decimals from uiTokenAmount, not the old hard-coded 0', () => {
    const changes = SolanaMainnet._decodeBalanceChanges(
      fakeTx({
        accountKeys: [ALICE, BOB, USDC_MINT],
        preBalances: [1_000_000_000, 0, 0],
        postBalances: [1_000_000_000, 0, 0], // no native change
        preTokenBalances: [
          {
            accountIndex: 0,
            mint: USDC_MINT,
            owner: ALICE,
            uiTokenAmount: { amount: '10000000', decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 0,
            mint: USDC_MINT,
            owner: ALICE,
            uiTokenAmount: { amount: '9000000', decimals: 6 },
          },
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: BOB,
            uiTokenAmount: { amount: '1000000', decimals: 6 },
          },
        ],
      }),
    );

    const spl = changes.filter((c) => c.token.identifier === USDC_MINT);
    expect(spl).toHaveLength(2);

    const alicePair = spl.find((c) => c.address === ALICE);
    const bobPair = spl.find((c) => c.address === BOB);
    expect(alicePair?.amount).toBe(-1_000_000n);
    expect(bobPair?.amount).toBe(1_000_000n);
    // Decimals now surface from the token-balance meta (was hard-coded to 0).
    expect(alicePair?.token.decimals).toBe(6);
    expect(bobPair?.token.decimals).toBe(6);
    // Address is the wallet owner, never the mint.
    expect(alicePair?.address).not.toBe(USDC_MINT);
    expect(bobPair?.address).not.toBe(USDC_MINT);
  });

  it('drops SPL entries whose token-account owner is null (was writing mint as address)', () => {
    const changes = SolanaMainnet._decodeBalanceChanges(
      fakeTx({
        accountKeys: [ALICE, USDC_MINT],
        preBalances: [1_000_000_000, 0],
        postBalances: [1_000_000_000, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: null,
            uiTokenAmount: { amount: '5000000', decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: null,
            uiTokenAmount: { amount: '0', decimals: 6 },
          },
        ],
      }),
    );

    // The single owner-less delta is skipped — mint never appears as a wallet address.
    const spl = changes.filter((c) => c.token.identifier === USDC_MINT);
    expect(spl).toHaveLength(0);
    for (const c of changes) expect(c.address).not.toBe(USDC_MINT);
  });

  it('promotes post-side owner into a pre entry that lacked one (fresh ATA)', () => {
    const changes = SolanaMainnet._decodeBalanceChanges(
      fakeTx({
        accountKeys: [ALICE, BOB, USDC_MINT],
        preBalances: [1_000_000_000, 0, 0],
        postBalances: [1_000_000_000, 0, 0],
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: USDC_MINT,
            owner: BOB,
            uiTokenAmount: { amount: '1000000', decimals: 6 },
          },
        ],
      }),
    );

    const bobChange = changes.find(
      (c) => c.token.identifier === USDC_MINT && c.address === BOB,
    );
    expect(bobChange?.amount).toBe(1_000_000n);
    expect(bobChange?.token.decimals).toBe(6);
  });
});
