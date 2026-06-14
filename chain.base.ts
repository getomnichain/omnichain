import { NetworkType } from './network_type.ts';

import { Token } from './token.ts';
import { TransactionStatus } from './transaction_status.ts';
import { UnsignedTransaction } from './unsigned_transaction.ts';

export interface CreateTransferRequest {
  from?: string;
  to: string;
  tokenIdentifier?: string;
  amount: bigint;
  memo?: string;
}

export abstract class Chain {
  readonly chainId: number;
  readonly name: string;
  readonly networkType: NetworkType;
  readonly blockTimeSeconds: number;
  readonly nativeSymbol: string;
  readonly explorerBaseUrl: string;

  protected constructor(
    chainId: number,
    name: string,
    networkType: NetworkType,
    blockTimeSeconds: number,
    nativeSymbol: string,
    explorerBaseUrl: string
  ) {
    if (!Number.isInteger(chainId)) {
      throw new Error('Chain chainId must be an integer');
    }
    this.chainId = chainId;
    this.name = name;
    this.networkType = networkType;
    this.blockTimeSeconds = blockTimeSeconds;
    this.nativeSymbol = nativeSymbol;
    this.explorerBaseUrl = explorerBaseUrl.replace(/\/$/, '');
  }

  abstract get nativeToken(): Token;

  abstract getWalletExplorerUrl(address: string): string;
  abstract getTokenExplorerUrl(tokenIdentifier?: string): string;
  abstract getTransactionExplorerUrl(txHash: string): string;

  abstract validateAddress(raw: string): boolean;
  abstract validateTokenIdentifier(raw: string | undefined): boolean;

  abstract getBalance(owner: string, tokenIdentifier?: string): Promise<bigint>;

  abstract createTransferUnsignedTransaction(req: CreateTransferRequest): Promise<UnsignedTransaction>;

  abstract getTransactionStatus(txHash: string): Promise<TransactionStatus>;

  abstract getChainTipHeight(): Promise<number>;

  toString(): string {
    return `Chain[chainId=${this.chainId}, name=${this.name}, networkType=${this.networkType}]`;
  }
}
