import axios, { AxiosInstance } from 'axios';

import { AssetBearingOutpoint } from './asset_outpoint.ts';
import { BtcInscriptionIndex } from './inscription_index.ts';

export interface UnisatIndexOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  pageSize?: number;
  maxPages?: number;
}

interface UnisatInscriptionUtxo {
  txid: string;
  vout: number;
  inscriptions?: Array<{ inscriptionId: string }>;
  isOpInRBF?: boolean;
}

interface UnisatInscriptionDataResponse {
  code: number;
  msg: string;
  data: {
    cursor: number;
    total: number;
    totalConfirmed?: number;
    totalUnconfirmed?: number;
    inscription?: UnisatInscriptionUtxo[];
    utxo?: UnisatInscriptionUtxo[];
  };
}

const DEFAULT_BASE_URL = 'https://open-api.unisat.io';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 200;

export class UnisatIndex implements BtcInscriptionIndex {
  private readonly client: AxiosInstance;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(options: UnisatIndexOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new Error('UnisatIndex: apiKey is required');
    }
    this.client = axios.create({
      baseURL: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
      timeout: options.timeoutMs ?? 10_000,
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  get name(): string {
    return 'unisat';
  }

  async outpointsWithInscriptions(address: string): Promise<readonly AssetBearingOutpoint[]> {
    const seen = new Set<string>();
    const out: AssetBearingOutpoint[] = [];
    let cursor = 0;
    for (let page = 0; page < this.maxPages; page++) {
      const { data } = await this.client.get<UnisatInscriptionDataResponse>(
        `/v1/indexer/address/${address}/inscription-data`,
        { params: { cursor, size: this.pageSize } }
      );
      if (data.code !== 0 && data.code !== undefined && data.code !== 200) {
        throw new Error(`UnisatIndex: ${data.code} ${data.msg}`);
      }
      const utxos = data.data.inscription ?? data.data.utxo ?? [];
      for (const u of utxos) {
        const key = `${u.txid}:${u.vout}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ txid: u.txid, vout: u.vout });
      }
      cursor += utxos.length;
      const total = data.data.total ?? 0;
      if (utxos.length === 0 || cursor >= total) break;
    }
    return out;
  }
}
