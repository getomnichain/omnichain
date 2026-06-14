import axios, { AxiosInstance } from 'axios';

import { AssetBearingOutpoint } from './asset_outpoint.ts';
import { BtcInscriptionIndex } from './inscription_index.ts';
import { BtcRareSatIndex } from './rare_sat_index.ts';
import { BtcRuneIndex } from './rune_index.ts';

export interface OrdiscanIndexOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface OrdiscanInscription {
  inscription_id: string;
  output: string;
}

interface OrdiscanRuneBalance {
  output: string;
}

interface OrdiscanRareSat {
  utxo: string;
}

interface OrdiscanList<T> {
  data: T[];
}

const DEFAULT_BASE_URL = 'https://api.ordiscan.com';

export class OrdiscanIndex
  implements BtcInscriptionIndex, BtcRuneIndex, BtcRareSatIndex
{
  private readonly client: AxiosInstance;

  constructor(options: OrdiscanIndexOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error('OrdiscanIndex: apiKey is required');
    }
    this.client = axios.create({
      baseURL: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
      timeout: options.timeoutMs ?? 10_000,
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
  }

  get name(): string {
    return 'ordiscan';
  }

  async outpointsWithInscriptions(address: string): Promise<readonly AssetBearingOutpoint[]> {
    const list = await this.fetch<OrdiscanInscription>(`/v1/address/${address}/inscriptions`);
    return mapOutpoints(list.map((i) => i.output));
  }

  async outpointsWithRunes(address: string): Promise<readonly AssetBearingOutpoint[]> {
    const list = await this.fetch<OrdiscanRuneBalance>(`/v1/address/${address}/runes`);
    return mapOutpoints(list.map((r) => r.output));
  }

  async outpointsWithRareSats(address: string): Promise<readonly AssetBearingOutpoint[]> {
    const list = await this.fetch<OrdiscanRareSat>(`/v1/address/${address}/rare-sats`);
    return mapOutpoints(list.map((r) => r.utxo));
  }

  private async fetch<T>(path: string): Promise<T[]> {
    const { data } = await this.client.get<OrdiscanList<T>>(path);
    return data.data ?? [];
  }
}

function mapOutpoints(rawOutpoints: readonly string[]): AssetBearingOutpoint[] {
  const out: AssetBearingOutpoint[] = [];
  for (const raw of rawOutpoints) {
    const op = parseOutput(raw);
    if (op) out.push(op);
  }
  return out;
}

function parseOutput(raw: string): { txid: string; vout: number } | null {
  const m = /^([0-9a-fA-F]{64}):(\d+)(?::\d+)?$/.exec(raw);
  if (!m) return null;
  const vout = parseInt(m[2], 10);
  if (!Number.isFinite(vout) || vout < 0) return null;
  return { txid: m[1].toLowerCase(), vout };
}
