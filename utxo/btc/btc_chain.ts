import { CreateTransferRequest } from '../../chain.base.ts';

import { GetUtxosOptions, UtxoChain, UtxoChainInit } from '../utxo_chain.ts';
import { UnsignedUtxoTransaction } from '../unsigned_utxo_transaction.ts';
import { UnspentTransactionOutput } from '../utxo.ts';
import { outpointKey, unionOutpoints } from './tools/asset_outpoint.ts';
import { BtcInscriptionIndex } from './tools/inscription_index.ts';
import { BtcRareSatIndex } from './tools/rare_sat_index.ts';
import { BtcRuneIndex } from './tools/rune_index.ts';
import { BtcNetworkParams, registerBtcChainParams } from './network_params.ts';

export interface BtcChainInit extends Omit<UtxoChainInit, 'params'> {
  params: BtcNetworkParams;
  inscriptionIndex?: BtcInscriptionIndex;
  runeIndex?: BtcRuneIndex;
  rareSatIndex?: BtcRareSatIndex;
}

export interface BtcGetUtxosOptions extends GetUtxosOptions {
  excludeInscriptions?: boolean;
  excludeRunes?: boolean;
  excludeRareSats?: boolean;
}

export interface CreateBtcTransferOptions extends CreateTransferRequest {
  feeRateSatsPerVByte?: number;
  feeTargetBlocks?: number;
  rbfEnabled?: boolean;
  changeAddress?: string;
  excludeInscriptions?: boolean;
  excludeRunes?: boolean;
  excludeRareSats?: boolean;
}

export class BtcChain extends UtxoChain {
  readonly params: BtcNetworkParams;
  readonly inscriptionIndex: BtcInscriptionIndex | null;
  readonly runeIndex: BtcRuneIndex | null;
  readonly rareSatIndex: BtcRareSatIndex | null;

  constructor(init: BtcChainInit) {
    super(init);
    this.params = init.params;
    this.inscriptionIndex = init.inscriptionIndex ?? null;
    this.runeIndex = init.runeIndex ?? null;
    this.rareSatIndex = init.rareSatIndex ?? null;
    registerBtcChainParams(BigInt(init.chainId), init.params);
  }

  async getUtxos(
    addresses: readonly string[],
    options?: BtcGetUtxosOptions
  ): Promise<UnspentTransactionOutput[]> {
    const all = await super.getUtxos(addresses);
    if (!options) return all;
    const { excludeInscriptions, excludeRunes, excludeRareSats } = options;
    if (!excludeInscriptions && !excludeRunes && !excludeRareSats) return all;
    if (excludeInscriptions && this.inscriptionIndex === null) {
      throw new Error(
        `${this.name}: excludeInscriptions requested but no inscriptionIndex was configured`
      );
    }
    if (excludeRunes && this.runeIndex === null) {
      throw new Error(
        `${this.name}: excludeRunes requested but no runeIndex was configured`
      );
    }
    if (excludeRareSats && this.rareSatIndex === null) {
      throw new Error(
        `${this.name}: excludeRareSats requested but no rareSatIndex was configured`
      );
    }
    const queries: Array<Promise<ReadonlyArray<{ txid: string; vout: number }>>> = [];
    for (const address of addresses) {
      if (excludeInscriptions) queries.push(this.inscriptionIndex!.outpointsWithInscriptions(address));
      if (excludeRunes) queries.push(this.runeIndex!.outpointsWithRunes(address));
      if (excludeRareSats) queries.push(this.rareSatIndex!.outpointsWithRareSats(address));
    }
    if (queries.length === 0) return all;
    const groups = await Promise.all(queries);
    const tainted = unionOutpoints(groups);
    if (tainted.size === 0) return all;
    return all.filter((u) => !tainted.has(outpointKey(u.txid, u.vout)));
  }

  async createTransferUnsignedTransaction(
    req: CreateBtcTransferOptions | CreateTransferRequest
  ): Promise<UnsignedUtxoTransaction> {
    const opts = req as CreateBtcTransferOptions;
    const getUtxosOptions: BtcGetUtxosOptions | undefined =
      opts.excludeInscriptions || opts.excludeRunes || opts.excludeRareSats
        ? {
            excludeInscriptions: opts.excludeInscriptions,
            excludeRunes: opts.excludeRunes,
            excludeRareSats: opts.excludeRareSats,
          }
        : undefined;
    return this.buildTransfer(req, getUtxosOptions);
  }
}
