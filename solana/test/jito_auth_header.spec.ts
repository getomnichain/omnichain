import { jest } from '@jest/globals';
import { SolanaChain } from '../solana_chain.ts';

function makeChain(auth?: string): SolanaChain {
  return new SolanaChain({
    chainId: -1901,
    name: 'JitoAuthHeaderTest',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
    jito: { url: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles', ...(auth ? { auth } : {}) },
  });
}

function captureFetch(payload: unknown, status = 200): { calls: RequestInit[]; restore: () => void } {
  const calls: RequestInit[] = [];
  const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url: unknown, init?: unknown) => {
    calls.push((init as RequestInit) ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload; },
    } as unknown as Response;
  });
  return { calls, restore: () => spy.mockRestore() };
}

describe('Jito auth header — must be x-jito-auth, not Authorization: Bearer (0.3.4 fix)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('submitJitoBundle sends x-jito-auth: <uuid>', async () => {
    const chain = makeChain('secret-uuid-abc');
    const cap = captureFetch({ jsonrpc: '2.0', id: 1, result: 'BUNDLE_ID_XYZ' });
    const bytes = new Uint8Array(200);
    bytes[0] = 1;
    for (let i = 1; i < 65; i++) bytes[i] = i;
    await chain.submitJitoBundle([bytes]).catch(() => undefined);
    cap.restore();
    const headers = cap.calls[0]?.headers as Record<string, string>;
    expect(headers['x-jito-auth']).toBe('secret-uuid-abc');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('getBundleStatus sends x-jito-auth: <uuid>', async () => {
    const chain = makeChain('secret-uuid-abc');
    const cap = captureFetch({ jsonrpc: '2.0', id: 1, result: { value: [] } });
    await chain.getBundleStatus('BUNDLE_ID_XYZ').catch(() => undefined);
    cap.restore();
    const headers = cap.calls[0]?.headers as Record<string, string>;
    expect(headers['x-jito-auth']).toBe('secret-uuid-abc');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('omits the auth header entirely when jito.auth is not configured', async () => {
    const chain = makeChain();
    const cap = captureFetch({ jsonrpc: '2.0', id: 1, result: { value: [] } });
    await chain.getBundleStatus('BUNDLE_ID_XYZ').catch(() => undefined);
    cap.restore();
    const headers = cap.calls[0]?.headers as Record<string, string>;
    expect(headers['x-jito-auth']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
  });
});

jest.setTimeout(10_000);
