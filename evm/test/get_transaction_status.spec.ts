import { jest } from '@jest/globals';
import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from 'ethers';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { isSuccess, isFailed, TransactionStatusTypes } from '../../transaction_status.ts';
import { Arbitrum } from '../evm_chains.ts';

const TX_HASH = '0xabc';

interface Spies {
  txSpy: ReturnType<typeof jest.spyOn>;
  receiptSpy: ReturnType<typeof jest.spyOn>;
  getBlockSpy: ReturnType<typeof jest.spyOn>;
  callSpy?: ReturnType<typeof jest.spyOn>;
}

function setup(args: {
  tx?: Partial<TransactionResponse> | null;
  receipt?: Partial<TransactionReceipt> | null;
  callError?: Error;
}): Spies {
  const tx =
    args.tx === null ? null : ({ from: '0xA', to: '0xB', value: 0n, ...args.tx } as TransactionResponse);
  const receipt = args.receipt === null ? null : (args.receipt as TransactionReceipt | null);
  const txSpy = jest.spyOn(JsonRpcProvider.prototype, 'getTransaction').mockResolvedValue(tx);
  const receiptSpy = jest
    .spyOn(JsonRpcProvider.prototype, 'getTransactionReceipt')
    .mockResolvedValue(receipt as TransactionReceipt | null);
  const getBlockSpy = jest
    .spyOn(JsonRpcProvider.prototype, 'getBlock')
    .mockResolvedValue(null);
  let callSpy: ReturnType<typeof jest.spyOn> | undefined;
  if (args.callError !== undefined) {
    callSpy = jest.spyOn(JsonRpcProvider.prototype, 'call').mockRejectedValue(args.callError);
  }
  return { txSpy, receiptSpy, getBlockSpy, callSpy };
}

function tearDown(s: Spies): void {
  s.txSpy.mockRestore();
  s.receiptSpy.mockRestore();
  s.getBlockSpy.mockRestore();
  s.callSpy?.mockRestore();
}

describe('EvmChain.getTransactionStatus (EvmTransactionStatus subclass)', () => {
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

  it('returns NotFound with null balanceChanges when no tx and no receipt exist', async () => {
    const s = setup({ tx: null, receipt: null });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.NotFound);
    expect(res.balanceChanges).toBeNull();
    expect(res.fees).toBeNull();
    expect(res.error).toBeNull();
    expect(res.inclusionAt).toBeNull();
    tearDown(s);
  });

  it('returns Pending with null balanceChanges + null fees when tx exists in mempool but no receipt', async () => {
    const s = setup({ tx: {}, receipt: null });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.Pending);
    expect(res.balanceChanges).toBeNull();
    expect(res.fees).toBeNull();
    expect(res.error).toBeNull();
    tearDown(s);
  });

  it('returns Success with populated balanceChanges + fees when receipt.status=1', async () => {
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
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(isSuccess(res)).toBe(true);
    expect(res.fees?.gasLimitUsed).toBe(21000n);
    expect(res.fees?.effectiveGasPrice).toBe(1_000_000_000n);
    expect(res.fees?.totalGasInWei).toBe(21000n * 1_000_000_000n);
    expect(res.error).toBeNull();
    expect(res.balanceChanges).not.toBeNull();
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
      callError: new Error('reverted with no data'),
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(isFailed(res)).toBe(true);
    expect(res.error?.code).toBe('REVERTED');
    expect(res.error?.reason).toBeUndefined();
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
      callError: revertErr,
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(isFailed(res)).toBe(true);
    expect(res.error?.code).toBe('REVERTED');
    expect(res.error?.reason).toBe('ERC20 : insufficient balance');
    tearDown(s);
  });

  it('Failed tx with value > 0 emits null balanceChanges (Python invariant — Failed carries no balance shifts)', async () => {
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
      callError: new Error('reverted'),
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.status).toBe(TransactionStatusTypes.Failed);
    expect(res.balanceChanges).toBeNull();
    expect(res.fees?.totalGasInWei).toBe(21000n * 1_000_000_000n);
    tearDown(s);
  });

  it('Success tx with value > 0 emits balanceChanges with sender debited by value+gasCost, recipient credited by value', async () => {
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
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(isSuccess(res)).toBe(true);
    const gasCost = 21000n * 1_000_000_000n;
    const senderInner = res.balanceChanges!.get('0xsender');
    const recipInner = res.balanceChanges!.get('0xrecipient');
    const senderEntry = [...senderInner!.values()][0];
    const recipEntry = [...recipInner!.values()][0];
    expect(senderEntry.change.balanceChangeMr).toBe(-(1_000_000n + gasCost));
    expect(recipEntry.change.balanceChangeMr).toBe(1_000_000n);
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
      callError: revertErr,
    });
    const res = await Arbitrum.getTransactionStatus(TX_HASH);
    expect(res.error?.code).toBe('REVERTED');
    expect(res.error?.reason).toBe('Panic(0x11)');
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
