import { Psbt, Transaction } from 'bitcoinjs-lib';

import { ChainError, ChainErrorKinds, isChainError } from '../errors.ts';
import { NetworkType } from '../network_type.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';

import { isByteArray, sameBytes } from './bytes.ts';
import {
  COMPACT_SIGNATURE_BYTES,
  isCompressedPublicKey,
  singleKeyPayment,
  verifyStrictSignature,
} from './keys.ts';
import { UtxoScriptTypes } from './script.ts';
import { FinalizedUtxoTransaction, UnspentTransactionOutput, UtxoSigner } from './utxo.ts';
import { UtxoNetworkParams } from './utxo_network_params.ts';

export interface UnsignedUtxoTransactionInit {
  chainId: number;
  params: UtxoNetworkParams;
  psbtBase64: string;
  selectedInputs: readonly UnspentTransactionOutput[];
  feeSats: number;
  feeRateSatsPerVByte: number;
  estimatedVBytes: number;
  totalInputSats: number;
  totalOutputSats: number;
  changeAddress: string | null;
  inputsToSign: Record<string, number[]>;
}

export class UnsignedUtxoTransaction extends UnsignedTransaction {
  readonly params: UtxoNetworkParams;
  readonly psbtBase64: string;
  readonly selectedInputs: readonly UnspentTransactionOutput[];
  readonly feeSats: number;
  readonly feeRateSatsPerVByte: number;
  readonly estimatedVBytes: number;
  readonly totalInputSats: number;
  readonly totalOutputSats: number;
  readonly changeAddress: string | null;
  readonly inputsToSign: Readonly<Record<string, number[]>>;

  constructor(init: UnsignedUtxoTransactionInit) {
    super(init.chainId, NetworkType.BTC);
    this.params = init.params;
    this.psbtBase64 = init.psbtBase64;
    this.selectedInputs = init.selectedInputs;
    this.feeSats = init.feeSats;
    this.feeRateSatsPerVByte = init.feeRateSatsPerVByte;
    this.estimatedVBytes = init.estimatedVBytes;
    this.totalInputSats = init.totalInputSats;
    this.totalOutputSats = init.totalOutputSats;
    this.changeAddress = init.changeAddress;
    this.inputsToSign = init.inputsToSign;
  }

  toPsbt(): Psbt {
    return Psbt.fromBase64(this.psbtBase64, { network: this.params.networkInfo });
  }

  signWith(signer: UtxoSigner): UnsignedUtxoTransaction {
    if (!isCompressedPublicKey(signer?.publicKey)) {
      throw this.invalid('signWith: signer.publicKey must be a 33-byte compressed secp256k1 public key');
    }
    const psbt = this.toPsbt();
    const owned = this.inputIndicesOwnedBy(psbt, signer.publicKey);
    if (owned.length === 0) {
      throw this.invalid('signWith: the signer owns none of the inputs');
    }
    const checkedSigner = {
      publicKey: signer.publicKey,
      sign: (hash: Uint8Array): Uint8Array => {
        const signature = signer.sign(hash);
        if (!isByteArray(signature) || signature.length !== COMPACT_SIGNATURE_BYTES) {
          throw this.invalid(
            `signWith: signer.sign must return a ${COMPACT_SIGNATURE_BYTES}-byte compact ECDSA signature`,
          );
        }
        return signature;
      },
    };
    for (const index of owned) {
      if (hasSignatureFrom(psbt, index, signer.publicKey)) continue;
      try {
        psbt.signInput(index, checkedSigner);
      } catch (err) {
        if (isChainError(err)) throw err;
        throw this.invalid(`signWith: signing input ${index} failed: ${errorMessage(err)}`, err);
      }
    }
    return this.withPsbt(psbt);
  }

  finalize(): FinalizedUtxoTransaction {
    const psbt = this.toPsbt();
    psbt.data.inputs.forEach((input, index) => {
      if (!input.partialSig || input.partialSig.length === 0) {
        throw this.invalid(`finalize: input ${index} is not signed`);
      }
      if (!signaturesAreValid(psbt, index)) {
        throw this.invalid(`finalize: input ${index} has an invalid signature`);
      }
    });
    let tx: Transaction;
    try {
      psbt.finalizeAllInputs();
      tx = psbt.extractTransaction();
    } catch (err) {
      throw this.invalid(`finalize: ${errorMessage(err)}`, err);
    }
    return { hex: tx.toHex(), txid: tx.getId(), vsize: tx.virtualSize() };
  }

  private inputIndicesOwnedBy(psbt: Psbt, publicKey: Uint8Array): number[] {
    const ownedScripts = [UtxoScriptTypes.P2WPKH, UtxoScriptTypes.P2PKH].map(
      (scriptType) => singleKeyPayment(publicKey, scriptType, this.params.networkInfo).output!,
    );
    return psbt.txInputs.flatMap((_, index) => {
      const script = prevoutScript(psbt, index);
      return script !== null && ownedScripts.some((owned) => sameBytes(owned, script)) ? [index] : [];
    });
  }

  private withPsbt(psbt: Psbt): UnsignedUtxoTransaction {
    return new UnsignedUtxoTransaction({
      chainId: this.chainId,
      params: this.params,
      psbtBase64: psbt.toBase64(),
      selectedInputs: this.selectedInputs,
      feeSats: this.feeSats,
      feeRateSatsPerVByte: this.feeRateSatsPerVByte,
      estimatedVBytes: this.estimatedVBytes,
      totalInputSats: this.totalInputSats,
      totalOutputSats: this.totalOutputSats,
      changeAddress: this.changeAddress,
      inputsToSign: this.inputsToSign,
    });
  }

  private invalid(message: string, cause?: unknown): ChainError {
    return new ChainError(
      ChainErrorKinds.InvalidArgument,
      `UnsignedUtxoTransaction.${message}`,
      { chainId: this.chainId },
      cause,
    );
  }
}

function prevoutScript(psbt: Psbt, index: number): Uint8Array | null {
  const input = psbt.data.inputs[index];
  if (input.witnessUtxo) return input.witnessUtxo.script;
  if (!input.nonWitnessUtxo) return null;
  return Transaction.fromBuffer(input.nonWitnessUtxo).outs[psbt.txInputs[index].index]?.script ?? null;
}

function hasSignatureFrom(psbt: Psbt, index: number, publicKey: Uint8Array): boolean {
  return psbt.data.inputs[index].partialSig?.some((sig) => sameBytes(sig.pubkey, publicKey)) ?? false;
}

function signaturesAreValid(psbt: Psbt, index: number): boolean {
  try {
    return psbt.validateSignaturesOfInput(index, verifyStrictSignature);
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
