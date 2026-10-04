import { jest } from '@jest/globals';
import { JsonRpcProvider, JsonRpcResult } from 'ethers';

import { ChainError, ChainErrorKinds, isChainError } from '../../errors.ts';
import { EvmChain } from '../evm_chain.ts';

const OWNER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const WORD = `0x${'00'.repeat(31)}07`;
const SECRET = 'sk7Q2x';
const KEYED_RPC_URL = `https://rpc.example.com/v1/${SECRET}`;

interface RpcCall {
  method: string;
  params: unknown;
}

type RpcReply = { result: unknown } | { error: { code: number; message: string } };

const chains: EvmChain[] = [];

function makeChain(
  rpc: { rpcUrl: string } | { rpcUrls: string[] } = { rpcUrl: 'http://127.0.0.1:1' },
): EvmChain {
  const chain = new EvmChain({
    chainId: 1,
    name: 'TestChain',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    ...rpc,
  });
  chains.push(chain);
  return chain;
}

function stubRpc(reply: RpcReply | Error): RpcCall[] {
  const calls: RpcCall[] = [];
  jest.spyOn(JsonRpcProvider.prototype, '_send').mockImplementation(async (payload) =>
    (Array.isArray(payload) ? payload : [payload]).map(({ id, method, params }) => {
      if (method === 'eth_chainId') return { id, result: '0x1' };
      calls.push({ method, params });
      if (reply instanceof Error) throw reply;
      return { id, ...reply } as JsonRpcResult;
    }),
  );
  return calls;
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

describe('EvmChain.getStorageAt', () => {
  afterEach(() => {
    for (const chain of chains.splice(0)) {
      (chain as unknown as { _provider: JsonRpcProvider | null })._provider?.destroy();
    }
    jest.restoreAllMocks();
  });

  it.each([
    ['checksummed', OWNER],
    ['lowercase without 0x', OWNER.slice(2).toLowerCase()],
    ['all uppercase', `0x${OWNER.slice(2).toUpperCase()}`],
    ['0X prefix', `0X${OWNER.slice(2)}`],
  ])('sends one eth_getStorageAt for a %s address, on a chain without supports7702', async (_label, address) => {
    const calls = stubRpc({ result: WORD });

    const word = await makeChain().getStorageAt(address, 2n);

    expect(word).toBe(WORD);
    expect(calls).toEqual([
      { method: 'eth_getStorageAt', params: [OWNER.toLowerCase(), '0x2', 'latest'] },
    ]);
  });

  it('returns a short reply lowercased and left-padded to 32 bytes', async () => {
    stubRpc({ result: '0xABCD' });

    await expect(makeChain().getStorageAt(OWNER, 0n)).resolves.toBe(`0x${'0'.repeat(60)}abcd`);
  });

  it('returns 32 zero bytes for an unset slot', async () => {
    stubRpc({ result: `0x${'00'.repeat(32)}` });

    await expect(makeChain().getStorageAt(OWNER, 9n)).resolves.toBe(`0x${'0'.repeat(64)}`);
  });

  it.each([
    ['0', 0n, '0x0'],
    ['2^256 - 1', 2n ** 256n - 1n, `0x${'f'.repeat(64)}`],
  ])('accepts slot %s', async (_label, slot, quantity) => {
    const calls = stubRpc({ result: WORD });

    await makeChain().getStorageAt(OWNER, slot);

    expect(calls).toEqual([
      { method: 'eth_getStorageAt', params: [OWNER.toLowerCase(), quantity, 'latest'] },
    ]);
  });

  it.each([
    ['not hex', 'not-an-address'],
    ['too short', '0x1234'],
    ['bad checksum', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD'],
  ])('rejects an invalid address (%s) before any RPC call', async (_label, address) => {
    const calls = stubRpc({ result: WORD });

    const err = await rejection(makeChain().getStorageAt(address, 2n));

    expect(err.kind).toBe(ChainErrorKinds.InvalidAddress);
    expect(err.meta.address).toBe(address);
    expect(calls).toEqual([]);
  });

  it.each([
    ['negative', -1n],
    ['2^256', 2n ** 256n],
    ['a number', 2],
    ['a string', '2'],
    ['null', null],
    ['undefined', undefined],
    ['an object without a prototype', Object.create(null)],
  ])('rejects a slot that is %s before any RPC call', async (_label, slot) => {
    const calls = stubRpc({ result: WORD });

    const err = await rejection(makeChain().getStorageAt(OWNER, slot as bigint));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(calls).toEqual([]);
  });

  it('reports a missing RPC configuration as RpcNotConfigured', async () => {
    const err = await rejection(makeChain({ rpcUrls: ['  '] }).getStorageAt(OWNER, 2n));

    expect(err.kind).toBe(ChainErrorKinds.RpcNotConfigured);
  });

  it.each([
    ['a node error', { error: { code: -32000, message: `upstream connection reset by ${KEYED_RPC_URL}` } }],
    ['a transport failure', new Error(`request to ${KEYED_RPC_URL} failed: ECONNRESET`)],
  ])('maps %s to RpcError with the address and without the RPC key', async (_label, failure) => {
    stubRpc(failure);

    const err = await rejection(makeChain({ rpcUrl: KEYED_RPC_URL }).getStorageAt(OWNER.toLowerCase(), 2n));
    const cause = err.cause as Error;

    expect(err.kind).toBe(ChainErrorKinds.RpcError);
    expect(err.meta.address).toBe(OWNER);
    expect(err.meta.rpcHost).toBe('https://rpc.example.com');
    expect(err.message).toContain(`Failed to read storage slot 2 of ${OWNER}`);
    expect(err.message).toContain('https://rpc.example.com');
    for (const text of [err.message, err.stack, cause.message, cause.stack]) {
      expect(text).not.toContain(SECRET);
    }
  });

  it.each([
    ['longer than 32 bytes', `0x${'00'.repeat(33)}`],
    ['odd-length hex', '0x7'],
    ['not hex', 'not-hex'],
    ['null', null],
  ])('maps a reply that is %s to RpcError', async (_label, reply) => {
    stubRpc({ result: reply });

    const err = await rejection(makeChain().getStorageAt(OWNER, 2n));

    expect(err.kind).toBe(ChainErrorKinds.RpcError);
    expect(err.meta.address).toBe(OWNER);
  });
});
