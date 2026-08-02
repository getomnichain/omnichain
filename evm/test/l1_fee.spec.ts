import { jest } from '@jest/globals';
import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from 'ethers';

import { isSuccess } from '../../transaction_status.ts';
import { Optimism, Arbitrum } from '../evm_chains.ts';

const TX_HASH = '0xL1feeTest';
const L1_FEE_WEI = 0x1bc16d674ec80000n; // 2 ether — chosen to dwarf the L2 gas
const L2_GAS_USED = 21000n;
const L2_GAS_PRICE = 1_000_000_000n;

interface Spies {
  txSpy: ReturnType<typeof jest.spyOn>;
  receiptSpy: ReturnType<typeof jest.spyOn>;
  sendSpy: ReturnType<typeof jest.spyOn>;
  getBlockSpy: ReturnType<typeof jest.spyOn>;
}

function setup(opts: {
  chain: typeof Optimism | typeof Arbitrum;
  rawReceiptExtras?: Record<string, unknown>;
}): Spies {
  const tx = {
    from: '0xSender',
    to: '0xRecipient',
    value: 0n,
    gasLimit: L2_GAS_USED,
    gasPrice: L2_GAS_PRICE,
  } as unknown as TransactionResponse;
  const receipt = {
    status: 1,
    blockNumber: 100,
    gasUsed: L2_GAS_USED,
    gasPrice: L2_GAS_PRICE,
    from: '0xSender',
    to: '0xRecipient',
    logs: [],
  } as unknown as TransactionReceipt;
  const txSpy = jest.spyOn(JsonRpcProvider.prototype, 'getTransaction').mockResolvedValue(tx);
  const receiptSpy = jest
    .spyOn(JsonRpcProvider.prototype, 'getTransactionReceipt')
    .mockResolvedValue(receipt);
  const getBlockSpy = jest
    .spyOn(JsonRpcProvider.prototype, 'getBlock')
    .mockResolvedValue(null);
  const sendSpy = jest
    .spyOn(JsonRpcProvider.prototype, 'send')
    .mockImplementation(async (method: string) => {
      if (method === 'eth_getTransactionReceipt') {
        return {
          status: '0x1',
          blockNumber: '0x64',
          gasUsed: `0x${L2_GAS_USED.toString(16)}`,
          effectiveGasPrice: `0x${L2_GAS_PRICE.toString(16)}`,
          ...(opts.rawReceiptExtras ?? {}),
        };
      }
      throw new Error(`unexpected send: ${method}`);
    });
  return { txSpy, receiptSpy, sendSpy, getBlockSpy };
}

function tearDown(s: Spies): void {
  s.txSpy.mockRestore();
  s.receiptSpy.mockRestore();
  s.sendSpy.mockRestore();
  s.getBlockSpy.mockRestore();
}

describe('OP-stack L1 fee accounting', () => {
  const origOpt = process.env.OPTIMISM_RPC_URL;
  const origArb = process.env.ARBITRUM_RPC_URL;

  beforeEach(() => {
    process.env.OPTIMISM_RPC_URL = 'http://stubbed-opt.local';
    process.env.ARBITRUM_RPC_URL = 'http://stubbed-arb.local';
    (Optimism as unknown as { _provider: unknown })._provider = null;
    (Arbitrum as unknown as { _provider: unknown })._provider = null;
  });

  afterEach(() => {
    if (origOpt === undefined) delete process.env.OPTIMISM_RPC_URL;
    else process.env.OPTIMISM_RPC_URL = origOpt;
    if (origArb === undefined) delete process.env.ARBITRUM_RPC_URL;
    else process.env.ARBITRUM_RPC_URL = origArb;
    (Optimism as unknown as { _provider: unknown })._provider = null;
    (Arbitrum as unknown as { _provider: unknown })._provider = null;
  });

  it('Optimism (hasL1Fee=true) reads l1Fee from raw eth_getTransactionReceipt', async () => {
    expect(Optimism.hasL1Fee).toBe(true);
    const s = setup({
      chain: Optimism,
      rawReceiptExtras: { l1Fee: `0x${L1_FEE_WEI.toString(16)}` },
    });
    const status = await Optimism.getTransactionStatus(TX_HASH);
    expect(isSuccess(status)).toBe(true);
    expect(status.fees?.l1FeeWei).toBe(L1_FEE_WEI);
    expect(status.fees?.totalGasInWei).toBe(L2_GAS_USED * L2_GAS_PRICE);
    expect(status.fees?.totalNativeDebitWei).toBe(L2_GAS_USED * L2_GAS_PRICE + L1_FEE_WEI);

    // Sender's native row includes the L1 fee (would have been off by
    // L1_FEE_WEI before iter-3's fix, and STILL off after iter-3's fix
    // because ethers strips l1Fee from parsed receipts).
    const senderInner = status.balanceChanges!.get('0xsender');
    const senderEntry = [...senderInner!.values()][0];
    expect(senderEntry.change.balanceChangeMr).toBe(
      -(L2_GAS_USED * L2_GAS_PRICE + L1_FEE_WEI),
    );

    // Raw send was actually invoked
    expect(s.sendSpy).toHaveBeenCalledWith('eth_getTransactionReceipt', [TX_HASH]);
    tearDown(s);
  });

  it('Optimism handles missing l1Fee in raw receipt gracefully (fees.l1FeeWei undefined)', async () => {
    const s = setup({ chain: Optimism, rawReceiptExtras: {} });
    const status = await Optimism.getTransactionStatus(TX_HASH);
    expect(status.fees?.l1FeeWei).toBeUndefined();
    expect(status.fees?.totalNativeDebitWei).toBe(L2_GAS_USED * L2_GAS_PRICE);
    tearDown(s);
  });

  it('Arbitrum (hasL1Fee=false) does NOT make the extra raw send', async () => {
    expect(Arbitrum.hasL1Fee).toBe(false);
    const s = setup({ chain: Arbitrum });
    await Arbitrum.getTransactionStatus(TX_HASH);
    // send should not have been called for eth_getTransactionReceipt on
    // Arbitrum (only Optimism/OP-stack chains gate the extra fetch).
    for (const call of s.sendSpy.mock.calls) {
      expect(call[0]).not.toBe('eth_getTransactionReceipt');
    }
    tearDown(s);
  });

  it('raw send throwing does NOT fail getTransactionStatus (approximate sender debit falls back to L2-only)', async () => {
    const s = setup({ chain: Optimism, rawReceiptExtras: { l1Fee: '0x0' } });
    s.sendSpy.mockImplementationOnce(async () => {
      throw new Error('raw send unavailable');
    });
    const status = await Optimism.getTransactionStatus(TX_HASH);
    expect(isSuccess(status)).toBe(true);
    expect(status.fees?.l1FeeWei).toBeUndefined();
    tearDown(s);
  });
});
