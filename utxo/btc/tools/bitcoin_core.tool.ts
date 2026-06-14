import axios, { AxiosInstance } from 'axios';

import { addressToScriptPubKey, detectScriptType } from '../../script.ts';
import { UtxoBroadcaster } from '../../tools/broadcaster.ts';
import { UtxoChainTipProvider } from '../../tools/chain_tip_provider.ts';
import { UtxoFeeEstimator } from '../../tools/fee_estimator.ts';
import { UtxoRawTransactionProvider } from '../../tools/raw_transaction_provider.ts';
import { UtxoProvider } from '../../tools/utxo_provider.ts';
import { UtxoNetworkParams } from '../../utxo_network_params.ts';
import {
  AddressBalance,
  BroadcastResult,
  FeeEstimate,
  RawTransactionView,
  TransactionInputRef,
  TransactionOutputView,
  UnspentTransactionOutput,
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
}

interface CoreVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
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

  constructor(options: BitcoinCoreToolOptions) {
    if (!options.baseUrl || options.baseUrl.trim().length === 0) {
      throw new Error('BitcoinCoreTool: baseUrl is required');
    }
    this.params = options.params;
    this.wallet = options.wallet;
    this.feeEstimateMode = options.feeEstimateMode ?? 'CONSERVATIVE';
    this.importTimestamp = options.importTimestamp ?? 'now';
    this.watchOnlyLabel = options.watchOnlyLabel ?? 'utxo-watch';
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
