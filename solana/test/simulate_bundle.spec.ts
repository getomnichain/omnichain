import { jest } from '@jest/globals';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

import { ChainError, ChainErrorKinds, isChainError } from '../../errors.ts';
import { SolanaChain } from '../solana_chain.ts';

const RPC_URL = 'https://solana-rpc.example.test';
const ANKR_KEY = 'a'.repeat(64);
const ANKR_URL = `https://rpc.ankr.com/solana/${ANKR_KEY}`;
const BLOCKHASH = '11111111111111111111111111111111';
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const USER = Keypair.generate().publicKey.toBase58();

function makeChain(rpcUrl = RPC_URL): SolanaChain {
  return new SolanaChain({
    chainId: -1702,
    name: 'SimulateBundleTest',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
    rpcUrl,
  });
}

function transfer(lamports = 1): Uint8Array {
  const payer = Keypair.generate().publicKey;
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports })],
  }).compileToV0Message();
  return new VersionedTransaction(message).serialize();
}

function transactionOfSize(size: number): Uint8Array {
  const payer = Keypair.generate().publicKey;
  const build = (memoBytes: number) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer,
        recentBlockhash: BLOCKHASH,
        instructions: [new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.alloc(memoBytes, 0x61) })],
      }).compileToV0Message(),
    ).serialize();
  let memoBytes = size - build(0).length;
  while (build(memoBytes).length > size) memoBytes -= 1;
  const tx = build(memoBytes);
  if (tx.length !== size) throw new Error(`could not build a ${size}-byte transaction`);
  return tx;
}

type Reply = { status?: number; body?: unknown; fail?: Error };

function stubFetch(reply: Reply): { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) });
    if (reply.fail) throw reply.fail;
    const status = reply.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => reply.body } as unknown as Response;
  });
  return { calls };
}

async function rejection(promise: Promise<unknown>): Promise<ChainError> {
  try {
    await promise;
  } catch (err) {
    if (isChainError(err)) return err;
    throw err;
  }
  throw new Error('expected a ChainError');
}

const succeeded = (transactionResults: unknown[]) => ({ jsonrpc: '2.0', id: 1, result: { value: { summary: 'succeeded', transactionResults } } });

const failed = (message: string, transactionResults: unknown[]) => ({
  jsonrpc: '2.0',
  id: 1,
  result: {
    value: {
      summary: { failed: { error: { TransactionFailure: [Array(64).fill(0), message] }, tx_signature: '1'.repeat(64) } },
      transactionResults,
    },
  },
});

describe('SolanaChain.simulateBundle', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('request', () => {
    it('sends both account configs, one entry per transaction, to the chain RPC', async () => {
      const txs = [transfer(1), transfer(2)];
      const { calls } = stubFetch({ body: succeeded([{}, {}]) });

      await makeChain().simulateBundle(txs, { postAccounts: [null, [USER]] });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(RPC_URL);
      expect(calls[0].body).toEqual({
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateBundle',
        params: [
          { encodedTransactions: txs.map((tx) => Buffer.from(tx).toString('base64')) },
          {
            skipSigVerify: true,
            replaceRecentBlockhash: false,
            preExecutionAccountsConfigs: [null, null],
            postExecutionAccountsConfigs: [null, { addresses: [USER], encoding: 'base64' }],
          },
        ],
      });
    });

    it('asks for no accounts when postAccounts is not given, and passes the verification options', async () => {
      const { calls } = stubFetch({ body: succeeded([{}]) });

      await makeChain().simulateBundle([transfer()], { sigVerify: true, replaceRecentBlockhash: true });

      expect((calls[0].body as { params: unknown[] }).params[1]).toEqual({
        skipSigVerify: false,
        replaceRecentBlockhash: true,
        preExecutionAccountsConfigs: [null],
        postExecutionAccountsConfigs: [null],
      });
    });

    it('accepts five transactions and a 1232-byte transaction', async () => {
      const { calls } = stubFetch({ body: succeeded([{}, {}, {}, {}, {}]) });

      await makeChain().simulateBundle([transfer(1), transfer(2), transfer(3), transfer(4), transactionOfSize(1232)]);

      expect(calls).toHaveLength(1);
    });

    it('accepts a 1213-byte transaction', async () => {
      const { calls } = stubFetch({ body: succeeded([{}]) });

      await makeChain().simulateBundle([transactionOfSize(1213)]);

      expect(calls).toHaveLength(1);
    });
  });

  describe('refusals before the call', () => {
    it.each([
      ['no transactions', () => [] as Uint8Array[], {}, 'a bundle holds 1 to 5 transactions, got 0'],
      ['six transactions', () => [1, 2, 3, 4, 5, 6].map(transfer), {}, 'a bundle holds 1 to 5 transactions, got 6'],
      ['a 1233-byte transaction', () => [new Uint8Array(1233)], {}, 'transaction 0 must be 65 to 1232 bytes, got 1233 bytes'],
      ['a 64-byte transaction', () => [transfer(), new Uint8Array(64)], {}, 'transaction 1 must be 65 to 1232 bytes, got 64 bytes'],
      ['bytes that are not a transaction', () => [new Uint8Array(200).fill(0xff)], {}, 'transaction 0 is not a serialized VersionedTransaction'],
      ['postAccounts of another length', () => [transfer(1), transfer(2)], { postAccounts: [[USER]] }, 'postAccounts needs one entry per transaction (2), got 1'],
      ['an empty postAccounts entry', () => [transfer()], { postAccounts: [[]] }, 'postAccounts[0] must be null or a non-empty array of addresses'],
    ])('refuses %s with InvalidArgument and makes no request', async (_name, txs, opts, message) => {
      const { calls } = stubFetch({ body: succeeded([]) });

      const err = await rejection(makeChain().simulateBundle(txs(), opts));

      expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
      expect(err.message).toContain(message);
      expect(calls).toHaveLength(0);
    });

    it('refuses an invalid address in postAccounts with InvalidAddress and makes no request', async () => {
      const { calls } = stubFetch({ body: succeeded([]) });

      const err = await rejection(makeChain().simulateBundle([transfer()], { postAccounts: [['not-a-key']] }));

      expect(err.kind).toBe(ChainErrorKinds.InvalidAddress);
      expect(calls).toHaveLength(0);
    });
  });

  describe('result', () => {
    it('maps each transaction and decodes the requested accounts', async () => {
      const data = Buffer.from([0x01, 0x02, 0x03]);
      stubFetch({
        body: succeeded([
          { err: null, logs: ['a'], unitsConsumed: 150, fee: 5000, postExecutionAccounts: [] },
          {
            err: null,
            logs: ['b'],
            unitsConsumed: 300,
            fee: 5000,
            postExecutionAccounts: [{ lamports: 4_995_000, data: [data.toString('base64'), 'base64'] }, null],
          },
        ]),
      });

      const result = await makeChain().simulateBundle([transfer(1), transfer(2)], { postAccounts: [null, [USER, USER]] });

      expect(result).toEqual({
        succeeded: true,
        failedIndex: null,
        error: null,
        transactions: [
          { err: null, logs: ['a'], unitsConsumed: 150, fee: 5000, postAccounts: [] },
          { err: null, logs: ['b'], unitsConsumed: 300, fee: 5000, postAccounts: [{ lamports: 4_995_000, data: new Uint8Array(data) }, null] },
        ],
      });
    });

    it('names the failing transaction from the results, which stop at it', async () => {
      stubFetch({
        body: failed('Error processing Instruction 0: custom program error: 0x1', [
          { err: null, logs: [], unitsConsumed: 150, fee: 5000, postExecutionAccounts: [] },
          { err: { InstructionError: [0, { Custom: 1 }] }, logs: [], unitsConsumed: 0, fee: null, postExecutionAccounts: [] },
        ]),
      });

      const result = await makeChain().simulateBundle([transfer(1), transfer(2), transfer(3)]);

      expect(result.succeeded).toBe(false);
      expect(result.failedIndex).toBe(1);
      expect(result.error).toBe('Error processing Instruction 0: custom program error: 0x1');
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[1].err).toEqual({ InstructionError: [0, { Custom: 1 }] });
    });

    it('returns a stale blockhash as a failed simulation instead of throwing', async () => {
      stubFetch({ body: failed('Blockhash not found', [{ err: 'BlockhashNotFound', logs: [], unitsConsumed: 0, postExecutionAccounts: [] }]) });

      const result = await makeChain().simulateBundle([transfer()]);

      expect(result).toEqual({
        succeeded: false,
        failedIndex: 0,
        error: 'Blockhash not found',
        transactions: [{ err: 'BlockhashNotFound', logs: [], unitsConsumed: 0, fee: null, postAccounts: [] }],
      });
    });
  });

  describe('errors', () => {
    it('throws FeatureNotSupported, without the key, when the RPC has no such method', async () => {
      stubFetch({ body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } } });

      const err = await rejection(makeChain(ANKR_URL).simulateBundle([transfer()]));

      expect(err.kind).toBe(ChainErrorKinds.FeatureNotSupported);
      expect(err.message).toContain('-32601 Method not found');
      expect(err.message).not.toContain(ANKR_KEY);
    });

    it('throws FeatureNotSupported when the RPC answers HTTP 410', async () => {
      stubFetch({ status: 410, body: { code: 410, message: 'The RPC call or parameters have been disabled' } });

      const err = await rejection(makeChain().simulateBundle([transfer()]));

      expect(err.kind).toBe(ChainErrorKinds.FeatureNotSupported);
      expect(err.message).toContain('HTTP 410');
    });

    it.each([
      ['another JSON-RPC error', { body: { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'duplicate transactions' } } }, '-32602 duplicate transactions'],
      ['another HTTP status', { status: 503, body: {} }, 'HTTP 503'],
      ['a reply without results', { body: { jsonrpc: '2.0', id: 1, result: { value: { summary: 'succeeded' } } } }, 'no summary or transaction results'],
      ['a transport failure', { fail: new Error(`connect ECONNREFUSED ${ANKR_URL}`) }, 'transport failed'],
    ])('throws RpcError, without the key, on %s', async (_name, reply, message) => {
      stubFetch(reply);

      const err = await rejection(makeChain(ANKR_URL).simulateBundle([transfer()]));

      expect(err.kind).toBe(ChainErrorKinds.RpcError);
      expect(err.message).toContain(message);
      expect(err.message).not.toContain(ANKR_KEY);
      expect(String(err.cause ?? '')).not.toContain(ANKR_KEY);
    });
  });
});
