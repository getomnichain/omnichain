import { jest } from '@jest/globals';
import { Decimal } from 'decimal.js';
import { Transaction } from 'bitcoinjs-lib';

import { CHAIN_ID_BITCOIN_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { TransactionStatusTypes } from '../../transaction_status.ts';
import { bitcoinMainnetChain } from '../btc/btc_chains.ts';
import type { RawTransactionView, UtxoTransaction, UtxoTransactionInput } from '../utxo.ts';
import { UtxoChain } from '../utxo_chain.ts';

const REAL_TX_HEX: string = (() => {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 1), 0);
  const p2pkh = Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    Buffer.alloc(20, 2),
    Buffer.from([0x88, 0xac]),
  ]);
  tx.addOutput(p2pkh, 70_000n);
  tx.addOutput(p2pkh, 9_000n);
  return tx.toHex();
})();

function chainWith(hydrate: () => Promise<UtxoTransaction>, raw: () => Promise<RawTransactionView>): UtxoChain {
  return bitcoinMainnetChain({
    chainId: CHAIN_ID_BITCOIN_MAINNET,
    utxoProvider: { getUtxos: async () => [], getAddressBalance: async () => ({ confirmedSats: 0, unconfirmedSats: 0 }) } as never,
    rawTxProvider: { getTransaction: raw, getTransactionWithInputs: hydrate, getRawTransactionHex: async () => REAL_TX_HEX, getRawTransactionHexBatch: async () => [REAL_TX_HEX] } as never,
    feeEstimator: { estimateFeeRate: async () => ({ satsPerVByte: 5 }) } as never,
    broadcaster: { broadcast: async () => ({ txid: 'x' }) } as never,
    chainTipProvider: { getChainTipHeight: async () => 800_000 } as never,
  });
}

function inputFromA(valueSats: number): UtxoTransactionInput {
  return {
    txid: 'p'.repeat(64),
    vout: 0,
    scriptPubkeyHex: '76a914aa88ac',
    address: 'A',
    valueSats: BigInt(valueSats),
    valueBtcHr: new Decimal(valueSats).div(1e8),
  };
}

describe('RIN-226 — UtxoTransactionStatus surfaces inputs and net per-address balance changes', () => {
  it('AC1 — inputs resolved in vin order with valueSats + valueBtcHr set', async () => {
    const inputs: UtxoTransactionInput[] = [inputFromA(50_000), inputFromA(30_000)];
    const hydrate: () => Promise<UtxoTransaction> = async () => ({
      inputs,
      outputs: [
        { valueSats: 70_000, scriptPubKeyHex: '76a914bb88ac', scriptType: 'p2pkh' as never, address: 'B' },
        { valueSats: 9_000, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: 'A' },
      ],
      netChangesHr: {
        A: new Decimal(9_000 - 50_000 - 30_000).div(1e8),
        B: new Decimal(70_000).div(1e8),
      },
      size: 200,
      vsize: 150,
      confirmations: 3,
      confirmationDatetime: new Date(1_700_000_000_000),
      txid: 'x', hex: REAL_TX_HEX, blockHeight: 800_000, fees: { absoluteSats: 1_000 },
    });
    const raw: () => Promise<RawTransactionView> = async () => ({
      txid: 'x', hex: REAL_TX_HEX,
      vin: [], vout: [
        { valueSats: 70_000, scriptPubKeyHex: '76a914bb88ac', scriptType: 'p2pkh' as never, address: 'B' },
        { valueSats: 9_000, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: 'A' },
      ],
      confirmations: 3, blockHeight: 800_000, blockTime: new Date(1_700_000_000_000),
      fees: { absoluteSats: 1_000 },
    });
    const chain = chainWith(hydrate, raw);
    const s = await chain.getTransactionStatus('x');
    expect(s.status).toBe(TransactionStatusTypes.Success);
    expect(s.inputs).not.toBeNull();
    expect(s.inputs!.length).toBe(2);
    expect(s.inputs![0].address).toBe('A');
    expect(s.inputs![0].valueSats).toBe(50_000n);
    expect(s.inputs![0].valueBtcHr.equals(new Decimal('0.0005'))).toBe(true);
    expect(s.inputs![1].valueSats).toBe(30_000n);
    expect(s.inputsUnresolvedReason).toBeNull();
  });

  it('AC2 — balanceChanges are NET per-address (A: -71_000, B: +70_000)', async () => {
    const hydrate: () => Promise<UtxoTransaction> = async () => ({
      inputs: [inputFromA(50_000), inputFromA(30_000)],
      outputs: [
        { valueSats: 70_000, scriptPubKeyHex: '76a914bb88ac', scriptType: 'p2pkh' as never, address: 'B' },
        { valueSats: 9_000, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: 'A' },
      ],
      netChangesHr: {
        A: new Decimal(-71_000).div(1e8),
        B: new Decimal(70_000).div(1e8),
      },
      size: 200, vsize: 150, confirmations: 3, confirmationDatetime: new Date(),
      txid: 'x', hex: REAL_TX_HEX, blockHeight: 800_000, fees: { absoluteSats: 1_000 },
    });
    const raw: () => Promise<RawTransactionView> = async () => ({
      txid: 'x', hex: REAL_TX_HEX, vin: [], vout: [
        { valueSats: 70_000, scriptPubKeyHex: '76a914bb88ac', scriptType: 'p2pkh' as never, address: 'B' },
        { valueSats: 9_000, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: 'A' },
      ],
      confirmations: 3, blockHeight: 800_000, blockTime: new Date(), fees: { absoluteSats: 1_000 },
    });
    const chain = chainWith(hydrate, raw);
    const s = await chain.getTransactionStatus('x');
    const a = [...s.balanceChanges!.get('A')!.values()][0].change;
    const b = [...s.balanceChanges!.get('B')!.values()][0].change;
    expect(a.balanceChangeMr).toBe(-71_000n);
    expect(b.balanceChangeMr).toBe(70_000n);
  });

  it('AC3 — self-send: only fee is attributed to the sender', async () => {
    const hydrate: () => Promise<UtxoTransaction> = async () => ({
      inputs: [inputFromA(100_000)],
      outputs: [
        { valueSats: 99_500, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: 'A' },
      ],
      netChangesHr: {
        A: new Decimal(-500).div(1e8),
      },
      size: 100, vsize: 90, confirmations: 3, confirmationDatetime: new Date(),
      txid: 'x', hex: REAL_TX_HEX, blockHeight: 800_000, fees: { absoluteSats: 500 },
    });
    const raw: () => Promise<RawTransactionView> = async () => ({
      txid: 'x', hex: REAL_TX_HEX, vin: [], vout: [
        { valueSats: 99_500, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: 'A' },
      ],
      confirmations: 3, blockHeight: 800_000, blockTime: new Date(), fees: { absoluteSats: 500 },
    });
    const chain = chainWith(hydrate, raw);
    const s = await chain.getTransactionStatus('x');
    expect(s.balanceChanges!.size).toBe(1);
    const a = [...s.balanceChanges!.get('A')!.values()][0].change;
    expect(a.balanceChangeMr).toBe(-500n);
  });

  it('AC4 — no outputCreditsByAddress method and no gross-legacy field on the status', async () => {
    const chain = chainWith(
      async () => ({ inputs: [], outputs: [], netChangesHr: {}, size: 0, vsize: 0, confirmations: 3, confirmationDatetime: new Date() , txid: 'x', hex: REAL_TX_HEX, blockHeight: 800_000, fees: null }),
      async () => ({ txid: 'x', hex: REAL_TX_HEX, vin: [], vout: [], confirmations: 3, blockHeight: 800_000, blockTime: new Date(), fees: null }),
    );
    const s = await chain.getTransactionStatus('x');
    expect((s as unknown as { outputCreditsByAddress?: unknown }).outputCreditsByAddress).toBeUndefined();
    expect((s as unknown as { grossOutputCreditsLegacy?: unknown }).grossOutputCreditsLegacy).toBeUndefined();
  });

  it('AC8 — provider read failure on confirmed → thrown RpcError (not a partial Success)', async () => {
    const chain = chainWith(
      async () => { throw new Error('provider borked'); },
      async () => { throw new Error('unused after consolidation'); },
    );
    let caught: unknown;
    try { await chain.getTransactionStatus('x'); } catch (e) { caught = e; }
    expect(isChainError(caught, ChainErrorKinds.RpcError)).toBe(true);
  });

  it('AC9 — coinbase input yields { coinbase: true, address: null, valueSats: 0n }', async () => {
    const coinbase: UtxoTransactionInput = {
      txid: '0'.repeat(64),
      vout: 0xffffffff,
      scriptPubkeyHex: '',
      address: null,
      valueSats: 0n,
      valueBtcHr: new Decimal(0),
      coinbase: true,
    };
    const chain = chainWith(
      async () => ({
        inputs: [coinbase],
        outputs: [{ valueSats: 3_125_000_000, scriptPubKeyHex: '76a914cc88ac', scriptType: 'p2pkh' as never, address: 'MINER' }],
        netChangesHr: { MINER: new Decimal(3_125_000_000).div(1e8) },
        size: 100, vsize: 100, confirmations: 100, confirmationDatetime: new Date(),
        txid: 'x', hex: REAL_TX_HEX, blockHeight: 800_000, fees: null,
      }),
      async () => ({ txid: 'x', hex: REAL_TX_HEX, vin: [], vout: [{ valueSats: 3_125_000_000, scriptPubKeyHex: '76a914cc88ac', scriptType: 'p2pkh' as never, address: 'MINER' }], confirmations: 100, blockHeight: 800_000, blockTime: new Date(), fees: null }),
    );
    const s = await chain.getTransactionStatus('x');
    expect(s.inputs![0].coinbase).toBe(true);
    expect(s.inputs![0].address).toBeNull();
    expect(s.inputs![0].valueSats).toBe(0n);
    expect(s.balanceChanges!.size).toBe(1);
    expect(s.balanceChanges!.has('MINER')).toBe(true);
  });

  it('AC11 — pending + tool returns inputs: [] (mempool provider skipped hydration) → inputs null, reason pending', async () => {
    const chain = chainWith(
      async () => ({
        inputs: [], outputs: [], netChangesHr: {}, size: 0, vsize: 0,
        confirmations: 0, confirmationDatetime: null,
        txid: 'x', hex: REAL_TX_HEX, blockHeight: null, fees: null,
      }),
      async () => ({ txid: 'x', hex: REAL_TX_HEX, vin: [], vout: [], confirmations: 0, blockHeight: null, blockTime: null, fees: null }),
    );
    const s = await chain.getTransactionStatus('x');
    expect(s.status).toBe(TransactionStatusTypes.Pending);
    expect(s.balanceChanges).toBeNull();
    expect(s.inputs).toBeNull();
    expect(s.inputsUnresolvedReason).toBe('pending');
  });

  it('AC12 — valueSats and valueBtcHr agree: Decimal(valueSats).div(1e8).equals(valueBtcHr)', async () => {
    const chain = chainWith(
      async () => ({
        inputs: [inputFromA(12_345_678)],
        outputs: [{ valueSats: 12_340_000, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: 'A' }],
        netChangesHr: { A: new Decimal(-5_678).div(1e8) },
        size: 100, vsize: 100, confirmations: 3, confirmationDatetime: new Date(),
        txid: 'x', hex: REAL_TX_HEX, blockHeight: 800_000, fees: { absoluteSats: 5_678 },
      }),
      async () => ({ txid: 'x', hex: REAL_TX_HEX, vin: [], vout: [{ valueSats: 12_340_000, scriptPubKeyHex: '76a914aa88ac', scriptType: 'p2pkh' as never, address: 'A' }], confirmations: 3, blockHeight: 800_000, blockTime: new Date(), fees: { absoluteSats: 5_678 } }),
    );
    const s = await chain.getTransactionStatus('x');
    for (const i of s.inputs!) {
      const derived = new Decimal(i.valueSats.toString()).div(1e8);
      expect(derived.equals(i.valueBtcHr)).toBe(true);
    }
  });
});

describe('RIN-226 — BitcoinCoreTool hybrid hydration (verbose=2 mempool tx falls back to walk)', () => {
  it('verbose=2 vin without prevout triggers a batched verbose=1 walk, not a throw', async () => {
    const { BitcoinCoreTool } = await import('../btc/tools/bitcoin_core.tool.ts');
    const { BITCOIN_MAINNET_PARAMS } = await import('../btc/network_params.ts');
    const rpcCalls: { method: string; params: unknown[] }[] = [];
    const batchCalls: { method: string; params: unknown[] }[][] = [];
    const parentTx = {
      txid: 'pparent',
      hex: '',
      vin: [],
      vout: [{ value: 0.0005, n: 0, scriptPubKey: { hex: '76a914aa88ac', address: 'A' } }],
      confirmations: 100,
    };
    const mempoolTx = {
      txid: 'mempool',
      hex: REAL_TX_HEX,
      vin: [{ txid: 'pparent', vout: 0 }],
      vout: [{ value: 0.0004, n: 0, scriptPubKey: { hex: '76a914bb88ac', address: 'B' } }],
      confirmations: 0,
    };
    const tool = new BitcoinCoreTool({
      baseUrl: 'http://x', user: 'u', password: 'p',
      params: BITCOIN_MAINNET_PARAMS as never,
      bitcoinCoreVerbose: 2,
    });
    const stubClient: { post: (path: string, body: string) => Promise<unknown> } = {
      post: async (_path: string, body: string) => {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed)) {
          batchCalls.push(parsed);
          return { data: parsed.map((c: { method: string; params: unknown[]; id: string }) => ({
            result: c.params[0] === 'pparent' ? parentTx : mempoolTx,
            error: null,
            id: c.id,
          })) };
        }
        rpcCalls.push(parsed);
        return { data: { result: mempoolTx, error: null } };
      },
    };
    (tool as unknown as { client: unknown }).client = stubClient;

    const out = await tool.getTransactionWithInputs('mempool');
    expect(out.confirmations).toBe(0);
    expect(out.inputs.length).toBe(1);
    expect(out.inputs[0].address).toBe('A');
    expect(out.inputs[0].valueSats).toBe(50_000n);
    expect(batchCalls.length).toBe(1);
    expect(batchCalls[0][0].method).toBe('getrawtransaction');
  });
});

jest.setTimeout(10_000);
