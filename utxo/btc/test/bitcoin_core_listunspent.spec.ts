import axios from 'axios';
import { address as bjsAddress } from 'bitcoinjs-lib';

import '../../ecc.ts';
import { BITCOIN_REGTEST_PARAMS } from '../network_params.ts';
import { BitcoinCoreTool } from '../tools/bitcoin_core.tool.ts';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

const TEST_ADDR = (() => {
  const TESTNET_P2WPKH = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  const decoded = bjsAddress.fromBech32(TESTNET_P2WPKH);
  return bjsAddress.toBech32(Buffer.from(decoded.data), decoded.version, 'bcrt');
})();

interface PostCall {
  body: { method?: string; params?: unknown[] };
}

function makeMockedTool() {
  const calls: PostCall[] = [];
  const queue: unknown[] = [];
  const post = jest.fn(async (_path: string, raw: string) => {
    calls.push({ body: JSON.parse(raw) });
    if (queue.length === 0) throw new Error('no queued response');
    return { data: queue.shift() };
  });
  mockedAxios.create.mockReturnValueOnce({ post } as unknown as ReturnType<typeof axios.create>);
  const tool = new BitcoinCoreTool({
    baseUrl: 'http://localhost:18443',
    user: 'u',
    password: 'p',
    params: BITCOIN_REGTEST_PARAMS,
  });
  const enqueue = (result: unknown) => queue.push({ result, error: null });
  return { tool, calls, enqueue };
}

describe('BitcoinCoreTool.getUtxos via listunspent', () => {
  beforeEach(() => {
    mockedAxios.create.mockReset();
  });

  it('imports an unseen address (descriptor) on first call, then calls listunspent', async () => {
    const { tool, calls, enqueue } = makeMockedTool();
    enqueue({ ismine: false, iswatchonly: false, solvable: true });
    enqueue({
      descriptor: `addr(${TEST_ADDR})#abcdef00`,
      checksum: 'abcdef00',
      isrange: false,
      issolvable: true,
      hasprivatekeys: false,
    });
    enqueue([{ success: true }]);
    enqueue([
      {
        txid: 'aa'.repeat(32),
        vout: 0,
        address: TEST_ADDR,
        scriptPubKey: '001475...',
        amount: 0.001,
        confirmations: 5,
        spendable: true,
        solvable: true,
        safe: true,
      },
    ]);

    const utxos = await tool.getUtxos(TEST_ADDR);

    expect(utxos).toHaveLength(1);
    expect(utxos[0].valueSats).toBe(100_000);
    expect(utxos[0].confirmations).toBe(5);

    const methods = calls.map((c) => c.body.method);
    expect(methods).toEqual(['getaddressinfo', 'getdescriptorinfo', 'importdescriptors', 'listunspent']);

    const lu = calls[3].body.params as unknown[];
    expect(lu[0]).toBe(0);
    expect(lu[2]).toEqual([TEST_ADDR]);
  });

  it('skips import when address is already in wallet (ismine = true)', async () => {
    const { tool, calls, enqueue } = makeMockedTool();
    enqueue({ ismine: true, iswatchonly: false, solvable: true });
    enqueue([]);
    await tool.getUtxos(TEST_ADDR);
    const methods = calls.map((c) => c.body.method);
    expect(methods).toEqual(['getaddressinfo', 'listunspent']);
  });

  it('skips import when address is already watch-only', async () => {
    const { tool, calls, enqueue } = makeMockedTool();
    enqueue({ ismine: false, iswatchonly: true, solvable: true });
    enqueue([]);
    await tool.getUtxos(TEST_ADDR);
    const methods = calls.map((c) => c.body.method);
    expect(methods).toEqual(['getaddressinfo', 'listunspent']);
  });

  it('caches imports per address (second call skips getaddressinfo)', async () => {
    const { tool, calls, enqueue } = makeMockedTool();
    enqueue({ ismine: false, iswatchonly: false, solvable: true });
    enqueue({
      descriptor: `addr(${TEST_ADDR})#abcdef00`,
      checksum: 'abcdef00',
      isrange: false,
      issolvable: true,
      hasprivatekeys: false,
    });
    enqueue([{ success: true }]);
    enqueue([]);
    enqueue([]);

    await tool.getUtxos(TEST_ADDR);
    await tool.getUtxos(TEST_ADDR);

    const methods = calls.map((c) => c.body.method);
    expect(methods).toEqual([
      'getaddressinfo',
      'getdescriptorinfo',
      'importdescriptors',
      'listunspent',
      'listunspent',
    ]);
  });

  it('throws when importdescriptors returns success=false', async () => {
    const { tool, enqueue } = makeMockedTool();
    enqueue({ ismine: false, iswatchonly: false, solvable: true });
    enqueue({
      descriptor: `addr(${TEST_ADDR})#abcdef00`,
      checksum: 'abcdef00',
      isrange: false,
      issolvable: true,
      hasprivatekeys: false,
    });
    enqueue([{ success: false, error: { code: -5, message: 'bad descriptor' } }]);

    await expect(tool.getUtxos(TEST_ADDR)).rejects.toThrow(/failed to import descriptor/);
  });
});
