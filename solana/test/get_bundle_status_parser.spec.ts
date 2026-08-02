import { jest } from '@jest/globals';
import { SolanaChain } from '../solana_chain.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

function makeChain(opts?: { jito?: boolean }): SolanaChain {
  return new SolanaChain({
    chainId: -1101,
    name: 'Solana Mainnet Test',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    ...(opts?.jito === false
      ? {}
      : { jito: { url: 'https://mainnet.block-engine.jito.wtf/api/v1/getBundleStatuses' } }),
  });
}

function mockFetchOnce(payload: unknown, status = 200): void {
  const resp = {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(resp as unknown as Response);
}

const RESP = (rows: Array<Record<string, unknown> | null>) => ({
  jsonrpc: '2.0', id: 1, result: { value: rows },
});

const ROW = (id: string, err: unknown, confirmation_status: string | undefined = 'finalized', slot = 42) => ({
  bundle_id: id, slot, confirmation_status, err,
});

async function expectChainError(p: Promise<unknown>, kind: (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds], msgRe?: RegExp): Promise<void> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(isChainError(caught, kind)).toBe(true);
  if (msgRe) expect((caught as Error).message).toMatch(msgRe);
}

describe('SolanaChain.getBundleStatus — err-shape parser', () => {
  afterEach(() => jest.restoreAllMocks());

  it('err === null → Landed', async () => {
    mockFetchOnce(RESP([ROW('b1', null)]));
    const s = await makeChain().getBundleStatus('b1');
    expect(s.state).toBe('Landed');
    expect(s.err).toBeUndefined();
    expect(s.bundleId).toBe('b1');
    expect(s.slot).toBe(42);
  });

  it('err === { Ok: null } → Landed', async () => {
    mockFetchOnce(RESP([ROW('b1', { Ok: null })]));
    const s = await makeChain().getBundleStatus('b1');
    expect(s.state).toBe('Landed');
    expect(s.err).toBeUndefined();
  });

  it('err === { Err: "InstructionError" } → Failed', async () => {
    mockFetchOnce(RESP([ROW('b1', { Err: 'InstructionError' })]));
    const s = await makeChain().getBundleStatus('b1');
    expect(s.state).toBe('Failed');
    expect(s.err).toBe('InstructionError');
  });

  it('err === "some string" (proxy shape) → Failed', async () => {
    mockFetchOnce(RESP([ROW('b1', 'blockhash not found')]));
    const s = await makeChain().getBundleStatus('b1');
    expect(s.state).toBe('Failed');
    expect(s.err).toBe('blockhash not found');
  });

  it('err omitted from row → Landed', async () => {
    mockFetchOnce(RESP([{ bundle_id: 'b1', slot: 42, confirmation_status: 'finalized' }]));
    const s = await makeChain().getBundleStatus('b1');
    expect(s.state).toBe('Landed');
    expect(s.err).toBeUndefined();
  });

  it('confirmation_status "confirmed" → Landed when no err', async () => {
    mockFetchOnce(RESP([ROW('b1', null, 'confirmed')]));
    const s = await makeChain().getBundleStatus('b1');
    expect(s.state).toBe('Landed');
  });

  it('confirmation_status "processed" with no err → Pending', async () => {
    mockFetchOnce(RESP([ROW('b1', null, 'processed')]));
    const s = await makeChain().getBundleStatus('b1');
    expect(s.state).toBe('Pending');
  });

  it('missing row for requested id → Pending', async () => {
    mockFetchOnce(RESP([ROW('OTHER', null)]));
    const s = await makeChain().getBundleStatus('b1');
    expect(s.state).toBe('Pending');
  });

  it('result.value === null → all requested ids Pending', async () => {
    mockFetchOnce({ jsonrpc: '2.0', id: 1, result: { value: null } });
    const arr = await makeChain().getBundleStatus(['b1', 'b2']);
    expect(arr.map((s) => s.state)).toEqual(['Pending', 'Pending']);
  });

  it('result.value non-array (malformed) → RpcError', async () => {
    mockFetchOnce({ jsonrpc: '2.0', id: 1, result: { value: 'oops' } });
    await expectChainError(makeChain().getBundleStatus('b1'), ChainErrorKinds.RpcError);
  });

  it('json.error present → RpcError with message', async () => {
    mockFetchOnce({ jsonrpc: '2.0', id: 1, error: { message: 'method not found' } });
    await expectChainError(makeChain().getBundleStatus('b1'), ChainErrorKinds.RpcError, /method not found/);
  });

  it('HTTP 429 → RpcError', async () => {
    mockFetchOnce({}, 429);
    await expectChainError(makeChain().getBundleStatus('b1'), ChainErrorKinds.RpcError, /HTTP 429/);
  });

  it('array form preserves input order and returns one row per id', async () => {
    mockFetchOnce(RESP([
      ROW('b2', { Err: 'x' }, 'finalized', 99),
      ROW('b1', null, 'finalized', 42),
    ]));
    const arr = await makeChain().getBundleStatus(['b1', 'b2']);
    expect(arr.length).toBe(2);
    expect(arr[0]).toMatchObject({ bundleId: 'b1', state: 'Landed', slot: 42 });
    expect(arr[1]).toMatchObject({ bundleId: 'b2', state: 'Failed', err: 'x', slot: 99 });
  });

  it('throws FeatureNotSupported when jito not configured', async () => {
    await expectChainError(makeChain({ jito: false }).getBundleStatus('b1'), ChainErrorKinds.FeatureNotSupported);
  });
});

jest.setTimeout(10_000);
