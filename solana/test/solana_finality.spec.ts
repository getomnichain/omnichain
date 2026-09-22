import { SolanaChain } from '../solana_chain.ts';
import {
  SOLANA_FINALIZED_CONFIRMATIONS,
  SolanaTransactionFees,
  SolanaTransactionStatus,
} from '../solana_transaction_status.ts';
import { TransactionStatusTypes } from '../../transaction_status.ts';
import { CHAIN_ID_SOLANA_MAINNET } from '../../chain_ids.ts';

function makeChain(): SolanaChain {
  return new SolanaChain({
    chainId: -1602,
    name: 'FinalityTest',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
  });
}

const FEE_PAYER = '5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4';
const CO_SIGNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const NON_SIGNER = '11111111111111111111111111111111';
const TX_HASH = '3'.repeat(88);

function buildTx(opts: {
  slot: number;
  accountKeys: string[];
  numRequiredSignatures: number;
  err?: unknown;
}) {
  return {
    slot: opts.slot,
    blockTime: 1_700_000_000,
    transaction: {
      message: {
        header: { numRequiredSignatures: opts.numRequiredSignatures },
        staticAccountKeys: opts.accountKeys.map((k) => ({ toBase58: () => k })),
      },
    },
    meta: {
      err: opts.err ?? null,
      fee: 5000,
      computeUnitsConsumed: 1000,
      preBalances: [1_000_000_000],
      postBalances: [999_995_000],
      preTokenBalances: [],
      postTokenBalances: [],
    },
  };
}

function stubConnection(
  chain: SolanaChain,
  handlers: {
    getTransaction?: (hash: string) => Promise<unknown>;
    getSignatureStatus?: (hash: string, opts?: unknown) => Promise<unknown>;
  },
): void {
  (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
    getTransaction: handlers.getTransaction ?? (async () => null),
    getSignatureStatus: handlers.getSignatureStatus ?? (async () => ({ value: null })),
    getBlockHeight: async () => 0,
  });
}

describe('RIN-296 — SolanaTransactionStatus surfaces slot / confirmations / confirmationStatus / signers', () => {
  it('AC1 — success path: slot + signers from getTransaction, confirmations + confirmationStatus from getSignatureStatus', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => buildTx({
        slot: 300_000_000,
        accountKeys: [FEE_PAYER, CO_SIGNER, NON_SIGNER],
        numRequiredSignatures: 2,
      }),
      getSignatureStatus: async () => ({
        value: { slot: 300_000_000, confirmations: 5, confirmationStatus: 'confirmed', err: null },
      }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.status).toBe(TransactionStatusTypes.Success);
    expect(s.slot).toBe(300_000_000);
    expect(s.confirmations).toBe(5);
    expect(s.confirmationStatus).toBe('confirmed');
    expect(s.signers).toEqual([FEE_PAYER, CO_SIGNER]);
  });

  it('AC2 — finalized normalisation: null confirmations → SOLANA_FINALIZED_CONFIRMATIONS (32)', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => buildTx({ slot: 300_000_000, accountKeys: [FEE_PAYER], numRequiredSignatures: 1 }),
      getSignatureStatus: async () => ({
        value: { slot: 300_000_000, confirmations: null, confirmationStatus: 'finalized', err: null },
      }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.confirmations).toBe(SOLANA_FINALIZED_CONFIRMATIONS);
    expect(s.confirmations).toBe(32);
    expect(s.confirmationStatus).toBe('finalized');
  });

  it('AC3 — ledger-pruned fallback: tx=null, sig-status finalized+no-err → Pending with slot/confirmations/confirmationStatus, signers=[]', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => null,
      getSignatureStatus: async () => ({
        value: { slot: 299_999_999, confirmations: null, confirmationStatus: 'finalized', err: null },
      }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.status).toBe(TransactionStatusTypes.Pending);
    expect(s.slot).toBe(299_999_999);
    expect(s.confirmations).toBe(SOLANA_FINALIZED_CONFIRMATIONS);
    expect(s.confirmationStatus).toBe('finalized');
    expect(s.signers).toEqual([]);
  });

  it('AC3b — ledger-pruned + err: Failed with fees=null, carries the finality snapshot', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => null,
      getSignatureStatus: async () => ({
        value: {
          slot: 299_999_999,
          confirmations: null,
          confirmationStatus: 'finalized',
          err: { InstructionError: [0, 'Custom'] },
        },
      }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.status).toBe(TransactionStatusTypes.Failed);
    expect(s.fees).toBeNull();
    expect(s.slot).toBe(299_999_999);
    expect(s.confirmations).toBe(SOLANA_FINALIZED_CONFIRMATIONS);
    expect(s.signers).toEqual([]);
  });

  it('AC4 — signer parsing: fee-payer-only tx yields exactly one signer in message order', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => buildTx({ slot: 1, accountKeys: [FEE_PAYER, NON_SIGNER], numRequiredSignatures: 1 }),
      getSignatureStatus: async () => ({ value: { slot: 1, confirmations: 1, confirmationStatus: 'confirmed', err: null } }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.signers).toEqual([FEE_PAYER]);
  });

  it('AC5 — no blockNumber property on SolanaTransactionStatus', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => buildTx({ slot: 1, accountKeys: [FEE_PAYER], numRequiredSignatures: 1 }),
      getSignatureStatus: async () => ({ value: { slot: 1, confirmations: 1, confirmationStatus: 'confirmed', err: null } }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(Object.prototype.hasOwnProperty.call(s, 'blockNumber')).toBe(false);
    expect((s as unknown as Record<string, unknown>).blockNumber).toBeUndefined();
  });

  it('AC7 — pre-0.6.0 SolanaTransactionStatus.successful call site compiles unchanged, finality fields default to null/[]', () => {
    const fees = new SolanaTransactionFees({
      feePayer: FEE_PAYER,
      feeLamports: 5000n,
      computeUnitsConsumed: 1000n,
      netLamportsChangeByFeePayer: -5000n,
    });
    const s = SolanaTransactionStatus.successful({
      chainId: CHAIN_ID_SOLANA_MAINNET,
      inclusionAt: null,
      balanceChanges: new Map(),
      fees,
    });
    expect(s.slot).toBeNull();
    expect(s.confirmations).toBeNull();
    expect(s.confirmationStatus).toBeNull();
    expect(s.signers).toEqual([]);
  });

  it('D1 — getTransaction and getSignatureStatus fire in parallel (both entered before either resolves)', async () => {
    const chain = makeChain();
    let txResolve: (v: unknown) => void = () => undefined;
    let sigResolve: (v: unknown) => void = () => undefined;
    const txDeferred = new Promise<unknown>((r) => { txResolve = r; });
    const sigDeferred = new Promise<unknown>((r) => { sigResolve = r; });
    let txEntered = false;
    let sigEntered = false;
    stubConnection(chain, {
      getTransaction: async () => { txEntered = true; return (await txDeferred) as ReturnType<typeof buildTx>; },
      getSignatureStatus: async () => { sigEntered = true; return await sigDeferred; },
    });
    const p = chain.getTransactionStatus(TX_HASH);
    await Promise.resolve();
    await Promise.resolve();
    expect(txEntered).toBe(true);
    expect(sigEntered).toBe(true);
    txResolve(buildTx({ slot: 1, accountKeys: [FEE_PAYER], numRequiredSignatures: 1 }));
    sigResolve({ value: { slot: 1, confirmations: 1, confirmationStatus: 'confirmed', err: null } });
    await p;
  });

  it('D2 — sig-status failure on success path degrades to null fields, does NOT fail the whole read', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => buildTx({ slot: 42, accountKeys: [FEE_PAYER, CO_SIGNER], numRequiredSignatures: 2 }),
      getSignatureStatus: async () => { throw new Error('transient rpc error'); },
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.status).toBe(TransactionStatusTypes.Success);
    expect(s.slot).toBe(42);
    expect(s.signers).toEqual([FEE_PAYER, CO_SIGNER]);
    expect(s.confirmations).toBeNull();
    expect(s.confirmationStatus).toBeNull();
  });

  it('D3 — pending() from ledger-pruned still-propagating carries slot + confirmations + confirmationStatus', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => null,
      getSignatureStatus: async () => ({
        value: { slot: 500, confirmations: 15, confirmationStatus: 'confirmed', err: null },
      }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.status).toBe(TransactionStatusTypes.Pending);
    expect(s.slot).toBe(500);
    expect(s.confirmations).toBe(15);
    expect(s.confirmationStatus).toBe('confirmed');
  });

  it('notFound: neither RPC returned a value → NotFound with no finality info', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => null,
      getSignatureStatus: async () => ({ value: null }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.status).toBe(TransactionStatusTypes.NotFound);
    expect(s.slot).toBeNull();
    expect(s.confirmations).toBeNull();
    expect(s.confirmationStatus).toBeNull();
    expect(s.signers).toEqual([]);
  });

  it('!tx.meta: Pending carries slot + signers even without meta', async () => {
    const chain = makeChain();
    stubConnection(chain, {
      getTransaction: async () => ({
        slot: 42,
        blockTime: null,
        transaction: {
          message: {
            header: { numRequiredSignatures: 2 },
            staticAccountKeys: [FEE_PAYER, CO_SIGNER].map((k) => ({ toBase58: () => k })),
          },
        },
        meta: null,
      }),
      getSignatureStatus: async () => ({ value: { slot: 42, confirmations: 5, confirmationStatus: 'confirmed', err: null } }),
    });
    const s = (await chain.getTransactionStatus(TX_HASH)) as SolanaTransactionStatus;
    expect(s.status).toBe(TransactionStatusTypes.Pending);
    expect(s.slot).toBe(42);
    expect(s.signers).toEqual([FEE_PAYER, CO_SIGNER]);
    expect(s.confirmations).toBe(5);
    expect(s.confirmationStatus).toBe('confirmed');
  });
});
