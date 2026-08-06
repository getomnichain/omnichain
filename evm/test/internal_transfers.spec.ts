import { jest } from '@jest/globals';
import { EvmChain, InternalEthTransfer } from '../evm_chain.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

function makeChain(): EvmChain {
  return new EvmChain({
    chainId: 1,
    name: 'InternalTransfersTest',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://127.0.0.1:1',
  });
}

const HASH = '0x' + 'aa'.repeat(32);

function mockProviderSend(traceResp: unknown, opts?: { throws?: Error }) {
  const chain = makeChain();
  (chain as unknown as { _provider: unknown })._provider = {
    send: async (method: string, params: unknown[]) => {
      if (method !== 'debug_traceTransaction') throw new Error(`unexpected method ${method}`);
      if (opts?.throws) throw opts.throws;
      return traceResp;
    },
  };
  return chain;
}

describe('EvmChain.getInternalTransfers', () => {
  it('extracts the top-level ETH transfer', async () => {
    const chain = mockProviderSend({
      type: 'CALL',
      from: '0xAAAA000000000000000000000000000000000001',
      to: '0xBBBB000000000000000000000000000000000002',
      value: '0xde0b6b3a7640000',
      calls: [],
    });
    const out = await chain.getInternalTransfers(HASH);
    expect(out).toEqual<InternalEthTransfer[]>([
      { from: '0xaaaa000000000000000000000000000000000001', to: '0xbbbb000000000000000000000000000000000002', value: 10n ** 18n },
    ]);
  });

  it('walks nested calls and captures router-mediated ETH forwarding (WETH.withdraw pattern)', async () => {
    const USER = '0x1111111111111111111111111111111111111111';
    const ROUTER = '0x2222222222222222222222222222222222222222';
    const WETH = '0x3333333333333333333333333333333333333333';
    const POOL = '0x4444444444444444444444444444444444444444';
    const wad = '0xe6f5cf3230000';
    const trace = {
      type: 'CALL',
      from: USER,
      to: ROUTER,
      value: '0x0',
      calls: [
        { type: 'CALL', from: ROUTER, to: POOL, value: '0x0', calls: [] },
        { type: 'CALL', from: ROUTER, to: WETH, value: '0x0', calls: [] },
        { type: 'CALL', from: WETH, to: ROUTER, value: wad, calls: [] },
        { type: 'CALL', from: ROUTER, to: USER, value: wad, calls: [] },
      ],
    };
    const out = await mockProviderSend(trace).getInternalTransfers(HASH);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ from: WETH.toLowerCase(), to: ROUTER.toLowerCase() });
    expect(out[1]).toMatchObject({ from: ROUTER.toLowerCase(), to: USER.toLowerCase() });
    expect(out.reduce((s, t) => (t.to === USER.toLowerCase() ? s + t.value : s), 0n)).toBe(BigInt(wad));
  });

  it('skips DELEGATECALL / STATICCALL (they cannot move ETH)', async () => {
    const chain = mockProviderSend({
      type: 'CALL',
      from: '0xaaa', to: '0xbbb', value: '0x0',
      calls: [
        { type: 'DELEGATECALL', from: '0xaaa', to: '0xccc', value: '0xdeadbeef', calls: [] },
        { type: 'STATICCALL', from: '0xaaa', to: '0xddd', value: '0xbeefcafe', calls: [] },
      ],
    });
    const out = await chain.getInternalTransfers(HASH);
    expect(out).toEqual([]);
  });

  it('skips reverted branches (call.error set)', async () => {
    const chain = mockProviderSend({
      type: 'CALL',
      from: '0xaaa', to: '0xbbb', value: '0x0',
      calls: [
        { type: 'CALL', from: '0xaaa', to: '0xccc', value: '0xff', error: 'execution reverted', calls: [
          { type: 'CALL', from: '0xccc', to: '0xddd', value: '0xff', calls: [] },
        ] },
      ],
    });
    const out = await chain.getInternalTransfers(HASH);
    expect(out).toEqual([]);
  });

  it('lowercases addresses on the way out', async () => {
    const chain = mockProviderSend({
      type: 'CALL', from: '0xAaBbCcDdEeFf00112233445566778899AaBbCcDd',
      to: '0xFfEeDdCcBbAa99887766554433221100FfEeDdCc',
      value: '0x1',
      calls: [],
    });
    const [t] = await chain.getInternalTransfers(HASH);
    expect(t.from).toBe(t.from.toLowerCase());
    expect(t.to).toBe(t.to.toLowerCase());
  });

  it('rejects malformed txHash as InvalidArgument', async () => {
    let caught: unknown;
    try { await mockProviderSend({}).getInternalTransfers('not-a-hash'); } catch (e) { caught = e; }
    expect(isChainError(caught, ChainErrorKinds.InvalidArgument)).toBe(true);
  });

  it('throws FeatureNotSupported when provider does not expose debug_traceTransaction', async () => {
    const chain = mockProviderSend(null, { throws: new Error('the method debug_traceTransaction does not exist/is not available') });
    let caught: unknown;
    try { await chain.getInternalTransfers(HASH); } catch (e) { caught = e; }
    expect(isChainError(caught, ChainErrorKinds.FeatureNotSupported)).toBe(true);
  });

  it('throws RpcError on other transport failures + no key leak', async () => {
    const chain = mockProviderSend(null, { throws: new Error('FetchError: request to https://x.alchemy.com/v2/SECRETKEY failed') });
    let caught: unknown;
    try { await chain.getInternalTransfers(HASH); } catch (e) { caught = e; }
    expect(isChainError(caught, ChainErrorKinds.RpcError)).toBe(true);
    expect(String(caught)).not.toContain('SECRETKEY');
  });

  it('deeply nested calls are all traversed', async () => {
    const chain = mockProviderSend({
      type: 'CALL', from: '0xaaa', to: '0xbbb', value: '0x0',
      calls: [{ type: 'CALL', from: '0xbbb', to: '0xccc', value: '0x0', calls: [
        { type: 'CALL', from: '0xccc', to: '0xddd', value: '0x0', calls: [
          { type: 'CALL', from: '0xddd', to: '0xeee', value: '0x2a', calls: [] },
        ] },
      ] }],
    });
    const out = await chain.getInternalTransfers(HASH);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({ from: '0xddd', to: '0xeee', value: 42n });
  });
});

jest.setTimeout(10_000);
