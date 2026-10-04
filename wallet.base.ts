import type { Chain } from './chain.base.ts';
import { ChainType, WalletFamily } from './chain_type.ts';
import { AbstractBroadcastTransactionResponse, AbstractSignedTransaction } from './signed_transaction.ts';
import { AbstractHandledPrerequisiteResponse, AbstractTransactionPrerequisite } from './transaction_prerequisite.ts';
import { UnsignedTransaction } from './unsigned_transaction.ts';

export abstract class AbstractSignedMessage {
  readonly signature: string;

  protected constructor(signature: string) {
    this.signature = signature;
  }
}

export interface SignedTransactionBroadcaster {
  broadcastSignedTransaction(signedTransaction: AbstractSignedTransaction): Promise<AbstractBroadcastTransactionResponse>;
}

export interface SignAndBroadcastTransactionRequest {
  transaction: UnsignedTransaction;
  chain: Chain & SignedTransactionBroadcaster;
  handlePrerequisites: boolean;
  prerequisites?: AbstractTransactionPrerequisite[];
}

export abstract class AbstractWallet {
  abstract chainType(): ChainType;

  abstract walletFamily(): WalletFamily;

  abstract handleTransactionPrerequisite(
    prerequisite: AbstractTransactionPrerequisite,
    chain: Chain,
  ): Promise<AbstractHandledPrerequisiteResponse>;

  async handleTransactionPrerequisites(prerequisites: AbstractTransactionPrerequisite[], chain: Chain): Promise<void> {
    for (const prerequisite of prerequisites) {
      await this.handleTransactionPrerequisite(prerequisite, chain);
    }
  }

  async signAndBroadcastTransaction(req: SignAndBroadcastTransactionRequest): Promise<AbstractBroadcastTransactionResponse> {
    if (req.handlePrerequisites === true) {
      await this.handleTransactionPrerequisites(req.prerequisites ?? [], req.chain);
    }
    const signed = await this.signTransaction(req.transaction, req.chain);
    return req.chain.broadcastSignedTransaction(signed);
  }

  abstract signTransaction(transaction: UnsignedTransaction, chain: Chain): Promise<AbstractSignedTransaction>;

  abstract signMessage(message: string): AbstractSignedMessage;

  abstract verifySignature(message: string, signedMessage: AbstractSignedMessage): boolean;
}

export abstract class AbstractBip32StyleSingleAccountWallet extends AbstractWallet {
  abstract get address(): string;
}
