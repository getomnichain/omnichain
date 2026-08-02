import { jest } from '@jest/globals';
import { Contract, JsonRpcProvider } from 'ethers';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { Arbitrum } from '../evm_chains.ts';
import { ARBITRUM_USDC } from '../evm_tokens.ts';

const OWNER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('getBalance', () => {
  const originalEnv = process.env.ARBITRUM_RPC_URL;

  beforeEach(() => {
    process.env.ARBITRUM_RPC_URL = 'http://stubbed-rpc.local';
    (Arbitrum as unknown as { _provider: unknown })._provider = null;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ARBITRUM_RPC_URL;
    else process.env.ARBITRUM_RPC_URL = originalEnv;
    (Arbitrum as unknown as { _provider: unknown })._provider = null;
    jest.restoreAllMocks();
  });

  it('native balance: calls provider.getBalance and returns bigint', async () => {
    const spy = jest
      .spyOn(JsonRpcProvider.prototype, 'getBalance')
      .mockResolvedValue(1_000_000_000_000_000_000n);
    const bal = await Arbitrum.getBalance(OWNER);
    expect(bal).toBe(1_000_000_000_000_000_000n);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns 0n when address has zero native balance', async () => {
    jest.spyOn(JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(0n);
    const bal = await Arbitrum.getBalance(OWNER);
    expect(bal).toBe(0n);
  });

  it('ERC20 balance: constructs Contract.balanceOf and returns bigint', async () => {
    const fn = jest.fn().mockResolvedValue(5_000_000n);
    jest.spyOn(Contract.prototype, 'getFunction').mockImplementation((name: unknown) => {
      if (name === 'balanceOf') return fn as unknown as ReturnType<typeof Contract.prototype.getFunction>;
      const fallback = (): never => {
        throw new Error(`unexpected ABI fn: ${String(name)}`);
      };
      return fallback as unknown as ReturnType<typeof Contract.prototype.getFunction>;
    });
    const bal = await Arbitrum.getBalance(OWNER, ARBITRUM_USDC.identifier);
    expect(bal).toBe(5_000_000n);
  });

  it('rejects an invalid owner address before touching the RPC', async () => {
    const spy = jest.spyOn(JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(0n);
    try {
      await Arbitrum.getBalance('not-an-address');
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidAddress)).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an invalid tokenIdentifier before touching the RPC', async () => {
    const spy = jest.spyOn(JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(0n);
    try {
      await Arbitrum.getBalance(OWNER, 'NATIVE');
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidTokenIdentifier)).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('wraps RPC errors as ChainError(rpc_error) with sanitized cause', async () => {
    jest
      .spyOn(JsonRpcProvider.prototype, 'getBalance')
      .mockRejectedValue(new Error('connection refused'));
    try {
      await Arbitrum.getBalance(OWNER);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.RpcError)).toBe(true);
    }
  });
});
