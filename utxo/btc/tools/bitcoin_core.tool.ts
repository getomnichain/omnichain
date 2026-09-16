import axios, { AxiosInstance } from 'axios';
import { Transaction } from 'bitcoinjs-lib';

import { addressToScriptPubKey, detectScriptType } from '../../script.ts';
import { UtxoBroadcaster } from '../../tools/broadcaster.ts';
import { UtxoChainTipProvider } from '../../tools/chain_tip_provider.ts';
import { UtxoFeeEstimator } from '../../tools/fee_estimator.ts';
import { UtxoRawTransactionProvider } from '../../tools/raw_transaction_provider.ts';
import { UtxoProvider } from '../../tools/utxo_provider.ts';
import { UtxoNetworkParams } from '../../utxo_network_params.ts';
import { Decimal } from 'decimal.js';

import {
  AddressBalance,
  BroadcastResult,
  FeeEstimate,
  RawTransactionView,
  TransactionInputRef,
  TransactionOutputView,
  UnspentTransactionOutput,
  UtxoTransaction,
  UtxoTransactionInput,
} from '../../utxo.ts';

export interface BitcoinCoreToolOptions {
  baseUrl: string;
  user: string;
  password: string;
  params: UtxoNetworkParams;
  wallet?: string;
  timeoutMs?: number;
  feeEstimateMode?: 'CONSERVATIVE' | 'ECONOMICAL';
  importTimestamp?: 'now' | number;
  watchOnlyLabel?: string;
  bitcoinCoreVerbose?: 1 | 2;
}

interface CoreVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  prevout?: {
    value: number;
    scriptPubKey: { hex: string; address?: string };
  };
}

interface CoreVout {
  value: number;
  n: number;
  scriptPubKey: { hex: string; address?: string; type?: string };
}

interface CoreTx {
  txid: string;
  hex: string;
  vin: CoreVin[];
  vout: CoreVout[];
  confirmations?: number;
  blockheight?: number;
  blocktime?: number;
  fee?: number;
}

interface CoreListUnspentItem {
  txid: string;
  vout: number;
  address: string;
  scriptPubKey: string;
  amount: number;
  confirmations: number;
  spendable: boolean;
  solvable: boolean;
  safe: boolean;
}

interface CoreAddressInfo {
  ismine: boolean;
  iswatchonly: boolean;
  solvable: boolean;
}

interface CoreDescriptorInfo {
  descriptor: string;
  checksum: string;
  isrange: boolean;
  issolvable: boolean;
  hasprivatekeys: boolean;
}

interface CoreImportDescriptorsResult {
  success: boolean;
  warnings?: string[];
  error?: { code: number; message: string };
}

interface CoreEstimateSmartFee {
  feerate?: number;
  blocks?: number;
  errors?: string[];
}

const SATS_PER_BTC = 100_000_000;

export class BitcoinCoreTool
  implements
    UtxoProvider,
    UtxoRawTransactionProvider,
    UtxoFeeEstimator,
    UtxoBroadcaster,
    UtxoChainTipProvider
{
  private readonly client: AxiosInstance;
  private readonly params: UtxoNetworkParams;
  private readonly wallet?: string;
  private readonly feeEstimateMode: 'CONSERVATIVE' | 'ECONOMICAL';
  private readonly importTimestamp: 'now' | number;
  private readonly watchOnlyLabel: string;
  private readonly watchedAddresses = new Set<string>();
  private readonly bitcoinCoreVerbose: 1 | 2;

  constructor(options: BitcoinCoreToolOptions) {
    if (!options.baseUrl || options.baseUrl.trim().length === 0) {
      throw new Error('BitcoinCoreTool: baseUrl is required');
    }
    this.params = options.params;
    this.wallet = options.wallet;
    this.feeEstimateMode = options.feeEstimateMode ?? 'CONSERVATIVE';
    this.importTimestamp = options.importTimestamp ?? 'now';
    this.watchOnlyLabel = options.watchOnlyLabel ?? 'utxo-watch';
    this.bitcoinCoreVerbose = options.bitcoinCoreVerbose ?? 1;
    const auth = Buffer.from(`${options.user}:${options.password}`).toString('base64');
    this.client = axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      timeout: options.timeoutMs ?? 10_000,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'text/plain' },
    });
  }

  get name(): string {
    return `bitcoin-core(${this.params.name})`;
  }

  async getUtxos(address: string): Promise<UnspentTransactionOutput[]> {
    await this.ensureAddressWatched(address);
    const items = await this.rpc<CoreListUnspentItem[]>('listunspent', [
      0,
      9_999_999,
      [address],
    ]);
    const scriptPubKey = addressToScriptPubKey(address, this.params.networkInfo);
    const scriptType = detectScriptType(scriptPubKey);
    const scriptPubKeyHex = Buffer.from(scriptPubKey).toString('hex');
    return items.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      valueSats: Math.round(u.amount * SATS_PER_BTC),
      scriptPubKeyHex,
      scriptType,
      confirmations: u.confirmations,
      ownerAddress: address,
    }));
  }

  async ensureAddressWatched(address: string): Promise<void> {
    if (this.watchedAddresses.has(address)) return;
    const info = await this.rpc<CoreAddressInfo>('getaddressinfo', [address]);
    if (info.ismine || info.iswatchonly) {
      this.watchedAddresses.add(address);
      return;
    }
    const descriptor = `addr(${address})`;
    const info2 = await this.rpc<CoreDescriptorInfo>('getdescriptorinfo', [descriptor]);
    const result = await this.rpc<CoreImportDescriptorsResult[]>('importdescriptors', [
      [
        {
          desc: info2.descriptor,
          timestamp: this.importTimestamp,
          active: false,
          internal: false,
          label: this.watchOnlyLabel,
        },
      ],
    ]);
    if (!result[0]?.success) {
      const err = result[0]?.error;
      throw new Error(
        `BitcoinCoreTool: failed to import descriptor for ${address}: ${err?.message ?? 'unknown error'}`
      );
    }
    this.watchedAddresses.add(address);
  }

  async getAddressBalance(address: string): Promise<AddressBalance> {
    const utxos = await this.getUtxos(address);
    let confirmed = 0;
    let unconfirmed = 0;
    for (const u of utxos) {
      if (u.confirmations > 0) confirmed += u.valueSats;
      else unconfirmed += u.valueSats;
    }
    return { confirmedSats: confirmed, unconfirmedSats: unconfirmed };
  }

  async getRawTransactionHex(txid: string): Promise<string> {
    return this.rpc<string>('getrawtransaction', [txid, false]);
  }

  async getRawTransactionHexBatch(txids: readonly string[]): Promise<string[]> {
    if (txids.length === 0) return [];
    return this.batchRpc<string>(txids.map((txid) => ({ method: 'getrawtransaction', params: [txid, false] })));
  }

  async getTransaction(txid: string): Promise<RawTransactionView> {
    const verbose = await this.rpc<CoreTx>('getrawtransaction', [txid, true]);
    const vin: TransactionInputRef[] = verbose.vin
      .filter((v) => v.txid !== undefined && v.vout !== undefined)
      .map((v) => ({ txid: v.txid!, vout: v.vout! }));
    const vout: TransactionOutputView[] = verbose.vout.map((o) => {
      const hex = o.scriptPubKey.hex;
      const buf = Buffer.from(hex, 'hex');
      return {
        valueSats: Math.round(o.value * SATS_PER_BTC),
        scriptPubKeyHex: hex,
        scriptType: detectScriptType(buf),
        address: o.scriptPubKey.address ?? null,
      };
    });
    return {
      txid: verbose.txid,
      hex: verbose.hex,
      vin,
      vout,
      confirmations: verbose.confirmations ?? 0,
      blockHeight: verbose.blockheight ?? null,
      blockTime: typeof verbose.blocktime === 'number' ? new Date(verbose.blocktime * 1000) : null,
      fees: verbose.fee !== undefined ? { absoluteSats: Math.round(verbose.fee * SATS_PER_BTC) } : null,
    };
  }

  async getTransactionWithInputs(txid: string): Promise<UtxoTransaction> {
    const main = await this.rpc<CoreTx>('getrawtransaction', [txid, this.bitcoinCoreVerbose]);

    const hydratedPrevouts = new Map<string, { valueSats: number; scriptPubkeyHex: string; address: string | null }>();
    const needsWalk: { txid: string; vout: number }[] = [];
    for (const v of main.vin) {
      if (v.coinbase !== undefined) continue;
      if (v.txid === undefined || v.vout === undefined) continue;
      if (v.prevout) {
        hydratedPrevouts.set(`${v.txid}:${v.vout}`, {
          valueSats: Math.round(v.prevout.value * SATS_PER_BTC),
          scriptPubkeyHex: v.prevout.scriptPubKey.hex,
          address: v.prevout.scriptPubKey.address ?? null,
        });
      } else {
        needsWalk.push({ txid: v.txid, vout: v.vout });
      }
    }

    if (needsWalk.length > 0) {
      const parentTxids = Array.from(new Set(needsWalk.map((v) => v.txid)));
      let parents: CoreTx[];
      try {
        parents = await this.batchRpc<CoreTx>(
          parentTxids.map((pTxid) => ({ method: 'getrawtransaction', params: [pTxid, 1] })),
        );
      } catch (err) {
        const rawMsg = err instanceof Error ? err.message : String(err);
        const scrubbed = rawMsg.replace(/getrawtransaction:/g, 'parent-prevout-fetch:');
        throw new Error(
          `BitcoinCoreTool.getTransactionWithInputs: prevout hydration failed for one of parents [${parentTxids.join(', ')}] on ${txid}: ${scrubbed}`,
        );
      }
      const parentByTxid = new Map<string, CoreTx>();
      for (let i = 0; i < parentTxids.length; i++) parentByTxid.set(parentTxids[i], parents[i]);
      for (const v of needsWalk) {
        const parent = parentByTxid.get(v.txid);
        if (!parent) {
          throw new Error(`BitcoinCoreTool.getTransactionWithInputs: parent tx ${v.txid} not returned`);
        }
        const out = parent.vout[v.vout];
        if (!out) {
          throw new Error(`BitcoinCoreTool.getTransactionWithInputs: parent tx ${v.txid} has no vout[${v.vout}]`);
        }
        hydratedPrevouts.set(`${v.txid}:${v.vout}`, {
          valueSats: Math.round(out.value * SATS_PER_BTC),
          scriptPubkeyHex: out.scriptPubKey.hex,
          address: out.scriptPubKey.address ?? null,
        });
      }
    }

    const inputs: UtxoTransactionInput[] = main.vin.map((v) => {
      if (v.coinbase !== undefined) {
        return {
          txid: '0'.repeat(64),
          vout: 0xffffffff,
          scriptPubkeyHex: '',
          address: null,
          valueSats: 0n,
          valueBtcHr: new Decimal(0),
          coinbase: true,
        };
      }
      const hydrated = hydratedPrevouts.get(`${v.txid}:${v.vout}`);
      if (!hydrated) {
        throw new Error(`BitcoinCoreTool.getTransactionWithInputs: missing hydrated prevout for ${v.txid}:${v.vout}`);
      }
      return {
        txid: v.txid!,
        vout: v.vout!,
        scriptPubkeyHex: hydrated.scriptPubkeyHex,
        address: hydrated.address,
        valueSats: BigInt(hydrated.valueSats),
        valueBtcHr: new Decimal(hydrated.valueSats).div(SATS_PER_BTC),
      };
    });

    const outputs: TransactionOutputView[] = main.vout.map((o) => {
      const hex = o.scriptPubKey.hex;
      const buf = Buffer.from(hex, 'hex');
      return {
        valueSats: Math.round(o.value * SATS_PER_BTC),
        scriptPubKeyHex: hex,
        scriptType: detectScriptType(buf),
        address: o.scriptPubKey.address ?? null,
      };
    });

    const netChangesHr: Record<string, Decimal> = {};
    for (const i of inputs) {
      if (i.address === null) continue;
      const prev = netChangesHr[i.address] ?? new Decimal(0);
      netChangesHr[i.address] = prev.minus(i.valueBtcHr);
    }
    for (const o of outputs) {
      if (o.address === null) continue;
      const prev = netChangesHr[o.address] ?? new Decimal(0);
      netChangesHr[o.address] = prev.plus(new Decimal(o.valueSats).div(SATS_PER_BTC));
    }
    for (const addr of Object.keys(netChangesHr)) {
      if (netChangesHr[addr].isZero()) delete netChangesHr[addr];
    }

    const rawBuf = Buffer.from(main.hex, 'hex');
    const size = rawBuf.byteLength;
    let vsize = size;
    try {
      vsize = Transaction.fromBuffer(rawBuf).virtualSize();
    } catch {
      vsize = size;
    }
    return {
      txid: main.txid,
      hex: main.hex,
      inputs,
      outputs,
      netChangesHr,
      size,
      vsize,
      confirmations: main.confirmations ?? 0,
      confirmationDatetime: typeof main.blocktime === 'number' ? new Date(main.blocktime * 1000) : null,
      blockHeight: main.blockheight ?? null,
      fees: main.fee !== undefined ? { absoluteSats: Math.round(main.fee * SATS_PER_BTC) } : null,
    };
  }

  async getFeeEstimate(targetBlocks: number): Promise<FeeEstimate> {
    const result = await this.rpc<CoreEstimateSmartFee>('estimatesmartfee', [
      targetBlocks,
      this.feeEstimateMode,
    ]);
    if (result.feerate === undefined) {
      throw new Error(
        `BitcoinCoreTool: estimatesmartfee returned no feerate (${result.errors?.join(', ') ?? 'no detail'})`
      );
    }
    const satsPerKvByte = Math.ceil(result.feerate * SATS_PER_BTC);
    const satsPerVByte = Math.max(1, Math.ceil(satsPerKvByte / 1000));
    return { satsPerVByte };
  }

  async broadcast(rawHex: string): Promise<BroadcastResult> {
    const txid = await this.rpc<string>('sendrawtransaction', [rawHex]);
    return { txid };
  }

  async getChainTipHeight(): Promise<number> {
    return this.rpc<number>('getblockcount', []);
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const path = this.wallet ? `/wallet/${this.wallet}` : '/';
    const body = JSON.stringify({ jsonrpc: '1.0', id: 'rpc', method, params });
    const { data } = await this.client.post<{ result: T; error: { code: number; message: string } | null }>(
      path,
      body
    );
    if (data.error) {
      throw new Error(`bitcoin-core ${method}: ${data.error.code} ${data.error.message}`);
    }
    return data.result;
  }

  private async batchRpc<T>(
    calls: readonly { method: string; params: unknown[] }[]
  ): Promise<T[]> {
    if (calls.length === 0) return [];
    const path = this.wallet ? `/wallet/${this.wallet}` : '/';
    const body = JSON.stringify(
      calls.map((c, i) => ({ jsonrpc: '1.0', id: `rpc-${i}`, method: c.method, params: c.params }))
    );
    const { data } = await this.client.post<
      Array<{ result: T; error: { code: number; message: string } | null; id: string }>
    >(path, body);
    const results: T[] = new Array(calls.length);
    for (const entry of data) {
      const idx = parseInt(entry.id.split('-')[1] ?? '', 10);
      if (!Number.isInteger(idx) || idx < 0 || idx >= calls.length) {
        throw new Error(`bitcoin-core batch: unexpected response id "${entry.id}"`);
      }
      if (entry.error) {
        throw new Error(
          `bitcoin-core[${idx}] ${calls[idx].method}: ${entry.error.code} ${entry.error.message}`
        );
      }
      results[idx] = entry.result;
    }
    return results;
  }
}
