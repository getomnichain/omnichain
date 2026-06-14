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

export interface EsploraToolOptions {
  baseUrl: string;
  params: UtxoNetworkParams;
  timeoutMs?: number;
}

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

interface EsploraVin {
  txid: string;
  vout: number;
}

interface EsploraVout {
  value: number;
  scriptpubkey: string;
  scriptpubkey_address?: string;
}

interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee?: number;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
}

interface EsploraAddressStats {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
}

export class EsploraTool
  implements
    UtxoProvider,
    UtxoRawTransactionProvider,
    UtxoFeeEstimator,
    UtxoBroadcaster,
    UtxoChainTipProvider
{
  private readonly client: AxiosInstance;
  private readonly params: UtxoNetworkParams;

  constructor(options: EsploraToolOptions) {
    if (!options.baseUrl || options.baseUrl.trim().length === 0) {
      throw new Error('EsploraTool: baseUrl is required');
    }
    this.params = options.params;
    this.client = axios.create({
      baseURL: options.baseUrl.replace(/\/$/, ''),
      timeout: options.timeoutMs ?? 10_000,
    });
  }

  get name(): string {
    return `esplora(${this.params.name})`;
  }

  async getRawTransactionHexBatch(txids: readonly string[]): Promise<string[]> {
    return Promise.all(txids.map((txid) => this.getRawTransactionHex(txid)));
  }

  async getUtxos(address: string): Promise<UnspentTransactionOutput[]> {
    const tipHeight = await this.getChainTipHeight();
    const { data } = await this.client.get<EsploraUtxo[]>(`/address/${address}/utxo`);
    const scriptPubKey = addressToScriptPubKey(address, this.params.networkInfo);
    const scriptType = detectScriptType(scriptPubKey);
    const scriptPubKeyHex = Buffer.from(scriptPubKey).toString('hex');
    return data.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      valueSats: u.value,
      scriptPubKeyHex,
      scriptType,
      confirmations: u.status.confirmed && u.status.block_height
        ? Math.max(0, tipHeight - u.status.block_height + 1)
        : 0,
      ownerAddress: address,
    }));
  }

  async getAddressBalance(address: string): Promise<AddressBalance> {
    const { data } = await this.client.get<EsploraAddressStats>(`/address/${address}`);
    const confirmed = data.chain_stats.funded_txo_sum - data.chain_stats.spent_txo_sum;
    const mempool = data.mempool_stats.funded_txo_sum - data.mempool_stats.spent_txo_sum;
    return { confirmedSats: confirmed, unconfirmedSats: mempool };
  }

  async getRawTransactionHex(txid: string): Promise<string> {
    const { data } = await this.client.get<string>(`/tx/${txid}/hex`, { responseType: 'text' });
    return data;
  }

  async getTransaction(txid: string): Promise<RawTransactionView> {
    const tipHeight = await this.getChainTipHeight();
    const [{ data: meta }, hex] = await Promise.all([
      this.client.get<EsploraTx>(`/tx/${txid}`),
      this.getRawTransactionHex(txid),
    ]);
    const vin: TransactionInputRef[] = meta.vin.map((v) => ({ txid: v.txid, vout: v.vout }));
    const vout: TransactionOutputView[] = meta.vout.map((o) => {
      const script = Buffer.from(o.scriptpubkey, 'hex');
      return {
        valueSats: o.value,
        scriptPubKeyHex: o.scriptpubkey,
        scriptType: detectScriptType(script),
        address: o.scriptpubkey_address ?? null,
      };
    });
    const blockHeight = meta.status.confirmed && meta.status.block_height ? meta.status.block_height : null;
    const blockTime =
      meta.status.confirmed && typeof meta.status.block_time === 'number'
        ? new Date(meta.status.block_time * 1000)
        : null;
    return {
      txid: meta.txid,
      hex,
      vin,
      vout,
      confirmations: blockHeight ? Math.max(0, tipHeight - blockHeight + 1) : 0,
      blockHeight,
      blockTime,
      fees: meta.fee !== undefined ? { absoluteSats: meta.fee } : null,
    };
  }

  async getFeeEstimate(targetBlocks: number): Promise<FeeEstimate> {
    const { data } = await this.client.get<Record<string, number>>(`/fee-estimates`);
    const keys = Object.keys(data)
      .map((k) => parseInt(k, 10))
      .filter((k) => !Number.isNaN(k))
      .sort((a, b) => a - b);
    let chosenKey: number | undefined;
    for (const k of keys) {
      if (k >= targetBlocks) {
        chosenKey = k;
        break;
      }
    }
    if (chosenKey === undefined) chosenKey = keys[keys.length - 1];
    if (chosenKey === undefined) throw new Error('EsploraTool: no fee estimates returned');
    const rate = Math.max(1, Math.ceil(data[String(chosenKey)]));
    return { satsPerVByte: rate };
  }

  async broadcast(rawHex: string): Promise<BroadcastResult> {
    const { data } = await this.client.post<string>(`/tx`, rawHex, {
      headers: { 'Content-Type': 'text/plain' },
      responseType: 'text',
    });
    return { txid: data.trim() };
  }

  async getChainTipHeight(): Promise<number> {
    const { data } = await this.client.get<string>(`/blocks/tip/height`, { responseType: 'text' });
    return parseInt(String(data).trim(), 10);
  }
}
