import { AddressLookupTableAccount, PublicKey, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';

import { ChainError, ChainErrorKinds } from '../errors.ts';
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
  /**
   * ALT accounts the message was compiled against. Kept so blockhash/CU rebuilds
   * recompile with the SAME ALTs — dropping them would silently change the
   * account-index layout and often push the tx over the 1232-byte wire limit.
   */
  addressLookupTables?: AddressLookupTableAccount[];
}

export class UnsignedSolanaTransaction extends UnsignedTransaction {
  readonly transaction: VersionedTransaction;
  readonly feePayer: string;
  readonly recentBlockhash: string;
  readonly lastValidBlockHeight: number;
  readonly instructions: TransactionInstruction[];
  readonly addressLookupTables: AddressLookupTableAccount[];

  constructor(init: UnsignedSolanaTransactionInit) {
    super(init.chainId, NetworkType.SOLANA);
    this.transaction = init.transaction;
    this.feePayer = init.feePayer;
    this.recentBlockhash = init.recentBlockhash;
    this.lastValidBlockHeight = init.lastValidBlockHeight;
    this.instructions = init.instructions;
    this.addressLookupTables = init.addressLookupTables ?? [];
  }

  /** Serializes the message (without signatures). Useful for off-line signers / tests. */
  messageBytes(): Uint8Array {
    return this.transaction.message.serialize();
  }

  /**
   * Alias for messageBytes(). The digest an external signer should sign for
   * this VersionedTransaction. Named to match the docs.
   */
  digestForSigning(): Uint8Array {
    return this.messageBytes();
  }

  /**
   * Attach externally-computed signatures (one per required signer, in the
   * message's signer order) and return the wire-ready serialized transaction
   * that can be handed to `chain.broadcast(bytes)`. Signature count must match
   * the compiled message's `numRequiredSignatures`.
   */
  finalizeAndSerialize(signatures: Uint8Array[]): Uint8Array {
    const required = this.transaction.message.header.numRequiredSignatures;
    if (signatures.length !== required) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `finalizeAndSerialize: expected ${required} signatures for this message (numRequiredSignatures), got ${signatures.length}`,
        { chainId: this.chainId },
      );
    }
    for (let i = 0; i < signatures.length; i++) {
      if (signatures[i].length !== 64) {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          `finalizeAndSerialize: signature[${i}] length ${signatures[i].length} !== 64 (ed25519)`,
          { chainId: this.chainId },
        );
      }
      this.transaction.addSignature(this.transaction.message.staticAccountKeys[i], signatures[i]);
    }
    return this.transaction.serialize();
  }

  get feePayerPubkey(): PublicKey {
    return new PublicKey(this.feePayer);
  }
}
