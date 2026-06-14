import { PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';

import { NetworkType } from '../network_type.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';

export interface UnsignedSolanaTransactionInit {
  chainId: number;
  /** A built VersionedTransaction (MessageV0) with a fresh blockhash baked in but no signatures yet. */
  transaction: VersionedTransaction;
  /** Base58 fee-payer pubkey (always the sender in our case). */
  feePayer: string;
  /** Recent blockhash used to build this tx; needed to decide if it must be re-built before signing. */
  recentBlockhash: string;
  /** Last slot at which this blockhash is valid. Used to bail before signing if expired. */
  lastValidBlockHeight: number;
  /**
   * Original instruction list — kept for rebuild operations (blockhash refresh, CU-limit re-tuning).
   * Without this the only way to refresh the blockhash would be to mutate `transaction.message`,
   * which is read-only by design in @solana/web3.js.
   */
  instructions: TransactionInstruction[];
}

export class UnsignedSolanaTransaction extends UnsignedTransaction {
  readonly transaction: VersionedTransaction;
  readonly feePayer: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
  readonly instructions: TransactionInstruction[];

  constructor(init: UnsignedSolanaTransactionInit) {
    super(init.chainId, NetworkType.SOLANA);
    this.transaction = init.transaction;
    this.feePayer = init.feePayer;
    this.recentBlockhash = init.recentBlockhash;
    this.lastValidBlockHeight = init.lastValidBlockHeight;
    this.instructions = init.instructions;
  }

  /** Serializes the message (without signatures). Useful for off-line signers / tests. */
  messageBytes(): Uint8Array {
    return this.transaction.message.serialize();
  }

  get feePayerPubkey(): PublicKey {
    return new PublicKey(this.feePayer);
  }
}
