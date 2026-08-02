import { jest } from '@jest/globals';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';

import { UnsignedSolanaTransaction } from '../unsigned_solana_transaction.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

const DUMMY_BLOCKHASH = '11111111111111111111111111111111';

function buildOneSignerTx(payer: PublicKey, chainId: number): UnsignedSolanaTransaction {
  const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 });
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: DUMMY_BLOCKHASH,
    instructions: [ix],
  }).compileToV0Message();
  return new UnsignedSolanaTransaction({
    chainId,
    feePayer: payer.toBase58(),
    transaction: new VersionedTransaction(message),
    recentBlockhash: DUMMY_BLOCKHASH,
    lastValidBlockHeight: 1_000_000,
    instructions: [ix],
    addressLookupTables: [],
  });
}

function signEd25519(digest: Uint8Array, keypair: Keypair): Uint8Array {
  const secretKey32 = keypair.secretKey.slice(0, 32);
  return ed25519.sign(digest, secretKey32);
}

describe('UnsignedSolanaTransaction.finalizeAndSerialize', () => {
  it('round-trips: signed bytes deserialize to the same message with a verifying signature', () => {
    const kp = Keypair.generate();
    const unsigned = buildOneSignerTx(kp.publicKey, -1102);
    const digest = unsigned.digestForSigning();

    const sig = signEd25519(digest, kp);
    expect(sig.length).toBe(64);

    const wireBytes = unsigned.finalizeAndSerialize([sig]);

    const decoded = VersionedTransaction.deserialize(wireBytes);
    expect(decoded.signatures.length).toBe(1);
    expect(Buffer.from(decoded.signatures[0]).equals(Buffer.from(sig))).toBe(true);

    const decodedMsgBytes = decoded.message.serialize();
    expect(Buffer.from(decodedMsgBytes).equals(Buffer.from(digest))).toBe(true);

    const ok = ed25519.verify(decoded.signatures[0], decodedMsgBytes, kp.publicKey.toBytes());
    expect(ok).toBe(true);
  });

  it('throws InvalidArgument on wrong signature count', () => {
    const kp = Keypair.generate();
    const unsigned = buildOneSignerTx(kp.publicKey, -1102);
    try {
      unsigned.finalizeAndSerialize([]);
      throw new Error('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      expect((err as Error).message).toMatch(/expected 1 signatures.*got 0/);
    }
    const sig = signEd25519(unsigned.digestForSigning(), kp);
    try {
      unsigned.finalizeAndSerialize([sig, sig]);
      throw new Error('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      expect((err as Error).message).toMatch(/expected 1 signatures.*got 2/);
    }
  });

  it('throws InvalidArgument on non-64-byte signature', () => {
    const kp = Keypair.generate();
    const unsigned = buildOneSignerTx(kp.publicKey, -1102);
    try {
      unsigned.finalizeAndSerialize([new Uint8Array(32)]);
      throw new Error('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
      expect((err as Error).message).toMatch(/length 32 !== 64/);
    }
  });

});

jest.setTimeout(10_000);
