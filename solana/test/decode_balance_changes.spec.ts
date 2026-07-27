import { assetHashOf } from '../../transaction_status.ts';
import { SolanaAddress } from '../solana_address.ts';
import { SolanaMainnet } from '../solana_chains.ts';

// Consumers that stub @solana/web3.js at the module-mapper layer (pluton's jest
// config does exactly this to avoid the rpc-websockets CJS/ESM parse issue) make
// SolanaAddress validation impossible: PublicKey.toBytes() returns a proxy whose
// .length is not the numeric 32. Detect that at load time and skip the suite;
// the assertions still run under any environment with the real @solana/web3.js.
const web3StubbedInEnv = ((): boolean => {
  try {
    new SolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    return false;
  } catch {
    return true;
  }
})();
const maybeDescribe = web3StubbedInEnv ? describe.skip : describe;

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

maybeDescribe('SolanaChain._decodeBalanceChanges (NestedBalanceChanges shape)', () => {
  it('SPL change: pulls decimals from uiTokenAmount, keyed by wallet then asset-hash', () => {
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

    const aliceInner = changes.get(ALICE);
    const bobInner = changes.get(BOB);
    expect(aliceInner).toBeDefined();
    expect(bobInner).toBeDefined();

    const aliceEntry = [...aliceInner!.values()].find(
      (e) => e.token.identifier === USDC_MINT,
    );
    const bobEntry = [...bobInner!.values()].find(
      (e) => e.token.identifier === USDC_MINT,
    );
    expect(aliceEntry?.change.balanceChangeMr).toBe(-1_000_000n);
    expect(bobEntry?.change.balanceChangeMr).toBe(1_000_000n);
    expect(aliceEntry?.token.decimals).toBe(6);
    expect(bobEntry?.token.decimals).toBe(6);
    // Mint address is never a wallet key.
    expect(changes.has(USDC_MINT)).toBe(false);
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

    // The single owner-less delta is skipped; no SPL entry appears anywhere.
    for (const [, inner] of changes) {
      for (const entry of inner.values()) {
        expect(entry.token.identifier).not.toBe(USDC_MINT);
      }
    }
    expect(changes.has(USDC_MINT)).toBe(false);
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

    const bobInner = changes.get(BOB);
    expect(bobInner).toBeDefined();
    const bobEntry = [...bobInner!.values()].find(
      (e) => e.token.identifier === USDC_MINT,
    );
    expect(bobEntry?.change.balanceChangeMr).toBe(1_000_000n);
    expect(bobEntry?.token.decimals).toBe(6);
    // Hash-key consistency: the inner-map key equals assetHashOf(token).
    expect(bobInner!.has(assetHashOf(bobEntry!.token))).toBe(true);
  });
});
