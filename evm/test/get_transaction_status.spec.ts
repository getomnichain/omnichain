import { jest } from '@jest/globals';
import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from 'ethers';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { TransactionStatusTypes } from '../../transaction_status.ts';
import { Arbitrum } from '../evm_chains.ts';

const TX_HASH = '0xabc';

interface Spies {
  txSpy: jest.SpyInstance;
  receiptSpy: jest.SpyInstance;
  blockSpy: jest.SpyInstance;
  getBlockSpy: jest.SpyInstance;
  callSpy?: jest.SpyInstance;
}

function setup(args: {
  tx?: Partial<TransactionResponse> | null;
  receipt?: Partial<TransactionReceipt> | null;
  blockNumber?: number;
  callError?: Error;
}): Spies {
  const tx = args.tx === null ? null : ({ from: '0xA', to: '0xB', value: 0n, ...args.tx } as TransactionResponse);
  const receipt = args.receipt === null ? null : (args.receipt as TransactionReceipt | null);
  const txSpy = jest.spyOn(JsonRpcProvider.prototype, 'getTransaction').mockResolvedValue(tx);
  const receiptSpy = jest
    .spyOn(JsonRpcProvider.prototype, 'getTransactionReceipt')
    .mockResolvedValue(receipt as TransactionReceipt | null);
  const blockSpy = jest
    .spyOn(JsonRpcProvider.prototype, 'getBlockNumber')
    .mockResolvedValue(args.blockNumber ?? 0);
  const getBlockSpy = jest
    .spyOn(JsonRpcProvider.prototype, 'getBlock')
    .mockResolvedValue(null);
  let callSpy: jest.SpyInstance | undefined;
  if (args.callError !== undefined) {
    callSpy = jest.spyOn(JsonRpcProvider.prototype, 'call').mockRejectedValue(args.callError);
  }
  return { txSpy, receiptSpy, blockSpy, getBlockSpy, callSpy };
}

function tearDown(s: Spies): void {
  s.txSpy.mockRestore();
  s.receiptSpy.mockRestore();
  s.blockSpy.mockRestore();
  s.getBlockSpy.mockRestore();
  s.callSpy?.mockRestore();
}

describe('getTransactionStatus', () => {
  const originalEnv = process.env.ARBITRUM_RPC_URL;

  beforeEach(() => {
    process.env.ARBITRUM_RPC_URL = 'http://stubbed-rpc.local';
    (Arbitrum as unknown as { _provider: unknown })._provider = null;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ARBITRUM_RPC_URL;
    else process.env.ARBITRUM_RPC_URL = originalEnv;
    (Arbitrum as unknown as { _provider: unknown })._provider = null;
  });

  it('returns NotFound when no tx and no receipt exist', async () => {
    const s = setup({ tx: null, receipt: null });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.NotFound);
    expect(res.confirmations).toBeNull();
    expect(res.balanceChanges).toEqual([]);
    expect(res.gasFee).toBeNull();
    expect(res.errorInfo).toBeNull();
    tearDown(s);
  });

  it('returns Pending when tx exists in mempool but no receipt', async () => {
    const s = setup({ tx: {}, receipt: null });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.Pending);
    expect(res.confirmations).toBeNull();
    tearDown(s);
  });

  it('returns Success with confirmations and gasFee when receipt.status=1', async () => {
    const s = setup({
      tx: { from: '0xSender', to: '0xRecipient', value: 0n },
      receipt: {
        status: 1,
        blockNumber: 100,
        gasUsed: 21000n,
        gasPrice: 1_000_000_000n,
        from: '0xSender',
        to: '0xRecipient',
        logs: [],
      } as unknown as Partial<TransactionReceipt>,
      blockNumber: 106,
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.Success);
    expect(res.confirmations).toBe(7);
    expect(res.gasFee?.amount).toBe(21000n * 1_000_000_000n);
    expect(res.gasFee?.token.isNative()).toBe(true);
    expect(res.errorInfo).toBeNull();
    tearDown(s);
  });

  it('returns Failed with code=REVERTED when receipt.status=0 and call replay does not reveal reason', async () => {
    const s = setup({
      tx: { from: '0xSender', to: '0xRecipient', value: 0n, data: '0x' },
      receipt: {
        status: 0,
        blockNumber: 100,
        gasUsed: 21000n,
        gasPrice: 1_000_000_000n,
        from: '0xSender',
        to: '0xRecipient',
        logs: [],
      } as unknown as Partial<TransactionReceipt>,
      blockNumber: 101,
      callError: new Error('reverted with no data'),
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.Failed);
    expect(res.errorInfo?.code).toBe('REVERTED');
    expect(res.errorInfo?.reason).toBeUndefined();
    tearDown(s);
  });

  it('extracts revert reason from call replay error.data (Error(string))', async () => {
    const errorStringSelector = '0x08c379a0';
    const reasonAbi =
      '0000000000000000000000000000000000000000000000000000000000000020' +
      '000000000000000000000000000000000000000000000000000000000000001c' +
      '4552433230203a20696e73756666696369656e742062616c616e636500000000';
    const revertErr = Object.assign(new Error('call exception'), {
      data: errorStringSelector + reasonAbi,
    });
    const s = setup({
      tx: { from: '0xSender', to: '0xRecipient', value: 0n, data: '0x' },
      receipt: {
        status: 0,
        blockNumber: 100,
        gasUsed: 21000n,
        gasPrice: 1_000_000_000n,
        from: '0xSender',
        to: '0xRecipient',
        logs: [],
      } as unknown as Partial<TransactionReceipt>,
      blockNumber: 101,
      callError: revertErr,
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.Failed);
    expect(res.errorInfo?.code).toBe('REVERTED');
    expect(res.errorInfo?.reason).toBe('ERC20 : insufficient balance');
    tearDown(s);
  });

  it('Failed tx with value > 0 emits NO native balanceChanges (reverted on-chain — no funds moved)', async () => {
    const s = setup({
      tx: { from: '0xSender', to: '0xRecipient', value: 1_000_000n, data: '0x' },
      receipt: {
        status: 0,
        blockNumber: 100,
        gasUsed: 21000n,
        gasPrice: 1_000_000_000n,
        from: '0xSender',
        to: '0xRecipient',
        logs: [],
      } as unknown as Partial<TransactionReceipt>,
      blockNumber: 101,
      callError: new Error('reverted'),
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.Failed);
    expect(res.balanceChanges).toEqual([]);
    expect(res.gasFee?.amount).toBe(21000n * 1_000_000_000n);
    tearDown(s);
  });

  it('Success tx with value > 0 DOES emit native balanceChanges (funds actually moved)', async () => {
    const s = setup({
      tx: { from: '0xSender', to: '0xRecipient', value: 1_000_000n, data: '0x' },
      receipt: {
        status: 1,
        blockNumber: 100,
        gasUsed: 21000n,
        gasPrice: 1_000_000_000n,
        from: '0xSender',
        to: '0xRecipient',
        logs: [],
      } as unknown as Partial<TransactionReceipt>,
      blockNumber: 101,
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.Success);
    expect(res.balanceChanges).toHaveLength(2);
    const sender = res.balanceChanges.find((c) => c.amount < 0n);
    const recipient = res.balanceChanges.find((c) => c.amount > 0n);
    expect(sender?.amount).toBe(-1_000_000n);
    expect(recipient?.amount).toBe(1_000_000n);
    tearDown(s);
  });

  it('replay omits gas/fee fields (EIP-1559 regression) so the node never rejects with mutually-exclusive args', async () => {
    let capturedCallArg: unknown;
    const callSpy = jest
      .spyOn(JsonRpcProvider.prototype, 'call')
      .mockImplementation(async (arg) => {
        capturedCallArg = arg;
        throw new Error('reverted with no data');
      });
    const s = setup({
      tx: {
        from: '0xSender',
        to: '0xRecipient',
        value: 0n,
        data: '0x',
        gasLimit: 21000n,
        gasPrice: 1_000_000_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_500_000_000n,
      } as unknown as Partial<TransactionResponse>,
      receipt: {
        status: 0,
        blockNumber: 100,
        gasUsed: 21000n,
        gasPrice: 1_000_000_000n,
        from: '0xSender',
        to: '0xRecipient',
        logs: [],
      } as unknown as Partial<TransactionReceipt>,
      blockNumber: 101,
    });
    await Arbitrum.getTransactionStatus(TX_HASH);

    const arg = capturedCallArg as Record<string, unknown>;
    expect(arg.from).toBeDefined();
    expect(arg.to).toBeDefined();
    expect(arg.blockTag).toBe(100);
    expect(arg.gasLimit).toBeUndefined();
    expect(arg.gasPrice).toBeUndefined();
    expect(arg.maxFeePerGas).toBeUndefined();
    expect(arg.maxPriorityFeePerGas).toBeUndefined();

    callSpy.mockRestore();
    tearDown(s);
  });

  it('decodes Panic(uint256) revert data', async () => {
    const panicSelector = '0x4e487b71';
    const panicPayload = '0000000000000000000000000000000000000000000000000000000000000011';
    const revertErr = Object.assign(new Error('panic'), { data: panicSelector + panicPayload });
    const s = setup({
      tx: { from: '0xSender', to: '0xRecipient', value: 0n, data: '0x' },
      receipt: {
        status: 0,
        blockNumber: 100,
        gasUsed: 21000n,
        gasPrice: 1_000_000_000n,
        from: '0xSender',
        to: '0xRecipient',
        logs: [],
      } as unknown as Partial<TransactionReceipt>,
      blockNumber: 101,
      callError: revertErr,
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.errorInfo?.code).toBe('REVERTED');
    expect(res.errorInfo?.reason).toBe('Panic(0x11)');
    tearDown(s);
  });

  it('wraps RPC errors as ChainError(rpc_error)', async () => {
    const txSpy = jest
      .spyOn(JsonRpcProvider.prototype, 'getTransaction')
      .mockRejectedValue(new Error('connection refused'));
    try {
      await Arbitrum.getTransactionStatus(TX_HASH);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.RpcError)).toBe(true);
    } finally {
      txSpy.mockRestore();
    }
  });
});
