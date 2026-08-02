import { jest } from '@jest/globals';
import { Contract, JsonRpcProvider } from 'ethers';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { Arbitrum } from '../evm_chains.ts';

const SECRET = 'SECRET-KEY-ABC123';
const URL_WITH_KEY = `https://rpc.example.com/v1/${SECRET}`;
const VALID_ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('rpcUrl never leaks into error messages (synthetic transport)', () => {
  const originalEnv = process.env.ARBITRUM_RPC_URL;
  let getBalanceSpy: ReturnType<typeof jest.spyOn> | undefined;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ARBITRUM_RPC_URL;
    else process.env.ARBITRUM_RPC_URL = originalEnv;
    (Arbitrum as unknown as { _provider: unknown })._provider = null;
    getBalanceSpy?.mockRestore();
  });

  it('rpc transport failure with a key-bearing URL: error message + cause chain contain host but NOT the key', async () => {
    process.env.ARBITRUM_RPC_URL = URL_WITH_KEY;
    (Arbitrum as unknown as { _provider: unknown })._provider = null;

    const synthetic = new Error(
      `network failure while talking to ${URL_WITH_KEY} (status=503)`
    );
    getBalanceSpy = jest
      .spyOn(JsonRpcProvider.prototype, 'getBalance')
      .mockRejectedValue(synthetic);

    try {
      await Arbitrum.getBalance(VALID_ADDR);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.RpcError)).toBe(true);
      const serialized = serializeWithCauseChain(err);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).toContain('rpc.example.com');
    }
  });

  it('ERC20 contract-call failure: same key sanitization on the cause chain', async () => {
    process.env.ARBITRUM_RPC_URL = URL_WITH_KEY;
    (Arbitrum as unknown as { _provider: unknown })._provider = null;
    const synthetic = new Error(
      `contract call timeout against ${URL_WITH_KEY}/rpc?method=eth_call`
    );
    const callSpy = jest
      .spyOn(Contract.prototype, 'getFunction')
      .mockImplementation(() => {
        const fn = (): Promise<bigint> => Promise.reject(synthetic);
        return fn as unknown as ReturnType<typeof Contract.prototype.getFunction>;
      });

    try {
      await Arbitrum.getBalance(VALID_ADDR, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831');
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.RpcError)).toBe(true);
      const serialized = serializeWithCauseChain(err);
      expect(serialized).not.toContain(SECRET);
    } finally {
      callSpy.mockRestore();
    }
  });
});

function serializeWithCauseChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 10) {
    if (cur instanceof Error) {
      parts.push(cur.stack ?? cur.message);
      parts.push(JSON.stringify(cur, Object.getOwnPropertyNames(cur)));
      cur = (cur as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      cur = undefined;
    }
    depth++;
  }
  return parts.join('\n');
}
