import axios from 'axios';

import { UnisatIndex } from '../tools/unisat.tool.ts';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

interface GetCall {
  url: string;
  params: Record<string, unknown> | undefined;
}

function makeMockedIndex(opts: { pageSize?: number; maxPages?: number } = {}) {
  const calls: GetCall[] = [];
  const queue: unknown[] = [];
  const get = jest.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
    calls.push({ url, params: config?.params });
    if (queue.length === 0) throw new Error('no queued mock response');
    return { data: queue.shift() };
  });
  mockedAxios.create.mockReturnValueOnce({ get } as unknown as ReturnType<typeof axios.create>);
  const index = new UnisatIndex({
    apiKey: 'k',
    pageSize: opts.pageSize ?? 2,
    maxPages: opts.maxPages ?? 5,
  });
  const enqueue = (response: unknown) => queue.push(response);
  return { index, calls, enqueue };
}

const TXID_A = 'aa'.repeat(32);
const TXID_B = 'bb'.repeat(32);
const TXID_C = 'cc'.repeat(32);

describe('UnisatIndex.outpointsWithInscriptions', () => {
  beforeEach(() => {
    mockedAxios.create.mockReset();
  });

  it('rejects construction without an apiKey', () => {
    expect(() => new UnisatIndex({ apiKey: '' })).toThrow();
    expect(() => new UnisatIndex({ apiKey: '   ' })).toThrow();
  });

  it('issues a single GET for a small response', async () => {
    const { index, calls, enqueue } = makeMockedIndex();
    enqueue({
      code: 0,
      msg: 'ok',
      data: {
        cursor: 0,
        total: 2,
        inscription: [
          { txid: TXID_A, vout: 0 },
          { txid: TXID_B, vout: 1 },
        ],
      },
    });
    const out = await index.outpointsWithInscriptions('bc1qexample');
    expect(out).toEqual([
      { txid: TXID_A, vout: 0 },
      { txid: TXID_B, vout: 1 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/inscription-data');
    expect(calls[0].params).toEqual({ cursor: 0, size: 2 });
  });

  it('paginates via cursor + size until total is reached', async () => {
    const { index, calls, enqueue } = makeMockedIndex({ pageSize: 2 });
    enqueue({
      code: 0,
      msg: 'ok',
      data: {
        cursor: 0,
        total: 3,
        inscription: [
          { txid: TXID_A, vout: 0 },
          { txid: TXID_B, vout: 0 },
        ],
      },
    });
    enqueue({
      code: 0,
      msg: 'ok',
      data: {
        cursor: 2,
        total: 3,
        inscription: [{ txid: TXID_C, vout: 0 }],
      },
    });
    const out = await index.outpointsWithInscriptions('bc1qexample');
    expect(out.map((o) => o.txid)).toEqual([TXID_A, TXID_B, TXID_C]);
    expect(calls.map((c) => c.params)).toEqual([
      { cursor: 0, size: 2 },
      { cursor: 2, size: 2 },
    ]);
  });

  it('stops paging when the server returns an empty list', async () => {
    const { index, calls, enqueue } = makeMockedIndex({ pageSize: 2 });
    enqueue({
      code: 0,
      msg: 'ok',
      data: { cursor: 0, total: 999, inscription: [] },
    });
    const out = await index.outpointsWithInscriptions('bc1qexample');
    expect(out).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('accepts the `utxo` field shape as a fallback for `inscription`', async () => {
    const { index, enqueue } = makeMockedIndex();
    enqueue({
      code: 0,
      msg: 'ok',
      data: {
        cursor: 0,
        total: 1,
        utxo: [{ txid: TXID_A, vout: 0 }],
      },
    });
    const out = await index.outpointsWithInscriptions('bc1qexample');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ txid: TXID_A, vout: 0 });
  });

  it('deduplicates outpoints if the server repeats them across pages', async () => {
    const { index, enqueue } = makeMockedIndex({ pageSize: 2 });
    enqueue({
      code: 0,
      msg: 'ok',
      data: {
        cursor: 0,
        total: 4,
        inscription: [
          { txid: TXID_A, vout: 0 },
          { txid: TXID_B, vout: 0 },
        ],
      },
    });
    enqueue({
      code: 0,
      msg: 'ok',
      data: {
        cursor: 2,
        total: 4,
        inscription: [
          { txid: TXID_A, vout: 0 },
          { txid: TXID_C, vout: 0 },
        ],
      },
    });
    const out = await index.outpointsWithInscriptions('bc1qexample');
    expect(out.map((o) => o.txid)).toEqual([TXID_A, TXID_B, TXID_C]);
  });

  it('surfaces non-success response codes as errors', async () => {
    const { index, enqueue } = makeMockedIndex();
    enqueue({ code: 401, msg: 'unauthorized', data: { cursor: 0, total: 0 } });
    await expect(index.outpointsWithInscriptions('bc1qexample')).rejects.toThrow(
      /401.*unauthorized/
    );
  });
});
