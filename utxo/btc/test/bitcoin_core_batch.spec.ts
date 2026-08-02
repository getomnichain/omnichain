import { jest } from '@jest/globals';
import axios from 'axios';

import {
  BITCOIN_REGTEST_PARAMS,
} from '../network_params.ts';
import { BitcoinCoreTool } from '../tools/bitcoin_core.tool.ts';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

interface PostCall {
  path: string;
  body: unknown;
}

function makeToolWithMock(): { tool: BitcoinCoreTool; calls: PostCall[]; nextResponse: (resp: unknown) => void } {
  const calls: PostCall[] = [];
  let queued: unknown[] = [];
  const post = jest.fn(async (path: string, body: string) => {
    calls.push({ path, body: JSON.parse(body) });
    if (queued.length === 0) throw new Error('no queued mock response');
    return { data: queued.shift() };
  });
  mockedAxios.create.mockReturnValueOnce({ post } as unknown as ReturnType<typeof axios.create>);
  const tool = new BitcoinCoreTool({
    baseUrl: 'http://localhost:18443',
    user: 'u',
    password: 'p',
    params: BITCOIN_REGTEST_PARAMS,
  });
  return { tool, calls, nextResponse: (resp) => queued.push(resp) };
}

describe('BitcoinCoreTool batch JSON-RPC', () => {
  beforeEach(() => {
    mockedAxios.create.mockReset();
  });

  it('getRawTransactionHexBatch sends a single array-body POST with all calls', async () => {
    const { tool, calls, nextResponse } = makeToolWithMock();
    nextResponse([
      { id: 'rpc-0', result: 'aaaa', error: null },
      { id: 'rpc-1', result: 'bbbb', error: null },
      { id: 'rpc-2', result: 'cccc', error: null },
    ]);
    const out = await tool.getRawTransactionHexBatch(['t1', 't2', 't3']);
    expect(out).toEqual(['aaaa', 'bbbb', 'cccc']);
    expect(calls).toHaveLength(1);
    const body = calls[0].body as Array<{ method: string; params: unknown[]; id: string }>;
    expect(body).toHaveLength(3);
    expect(body[0].method).toBe('getrawtransaction');
    expect(body[0].params).toEqual(['t1', false]);
    expect(body[0].id).toBe('rpc-0');
    expect(body[2].id).toBe('rpc-2');
  });

  it('rearranges out-of-order batch responses by id', async () => {
    const { tool, nextResponse } = makeToolWithMock();
    nextResponse([
      { id: 'rpc-2', result: 'C', error: null },
      { id: 'rpc-0', result: 'A', error: null },
      { id: 'rpc-1', result: 'B', error: null },
    ]);
    const out = await tool.getRawTransactionHexBatch(['ta', 'tb', 'tc']);
    expect(out).toEqual(['A', 'B', 'C']);
  });

  it('surfaces per-call errors with the originating method', async () => {
    const { tool, nextResponse } = makeToolWithMock();
    nextResponse([
      { id: 'rpc-0', result: 'A', error: null },
      { id: 'rpc-1', result: null, error: { code: -5, message: 'No such mempool transaction' } },
    ]);
    await expect(tool.getRawTransactionHexBatch(['ok', 'missing'])).rejects.toThrow(
      /getrawtransaction.*No such mempool/
    );
  });

  it('empty input → empty output, no HTTP call', async () => {
    const { tool, calls } = makeToolWithMock();
    const out = await tool.getRawTransactionHexBatch([]);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
