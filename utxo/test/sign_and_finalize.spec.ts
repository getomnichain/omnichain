import { Transaction, payments } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

import { ChainError, ChainErrorKinds, isChainError } from '../../errors.ts';
import { bitcoinTestnetChain } from '../btc/btc_chains.ts';
import { utxoFromRawTransaction } from '../raw_transaction.ts';
import { UtxoScriptTypes } from '../script.ts';
import { UnsignedUtxoTransaction } from '../unsigned_utxo_transaction.ts';
import {
  AddressBalance,
  BroadcastResult,
  FeeEstimate,
  UnspentTransactionOutput,
  UtxoPsbtInput,
  UtxoPsbtOutput,
  UtxoSigner,
} from '../utxo.ts';

import { TestKey, fundedInput, fundingTransactionHex, offlineChain } from './multisigner_helpers.ts';

const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const chain = offlineChain();
const owner1 = TestKey.fromByte(0x11);
const owner2 = TestKey.fromByte(0x22);
const ownerZ = TestKey.fromByte(0x44);
const recipient = chain.addressForPublicKey(TestKey.fromByte(0x33).publicKey);

function payTo(address: string, valueSats: number): UtxoPsbtOutput {
  return { kind: 'address', address, valueSats };
}

function threeOwnerTransaction(): UnsignedUtxoTransaction {
  return chain.assembleTransaction({
    inputs: [fundedInput(chain, owner1, 30_000), fundedInput(chain, owner2, 40_000), fundedInput(chain, ownerZ, 50_000)],
    outputs: [payTo(recipient, 110_000)],
  });
}

function signedInputs(unsigned: UnsignedUtxoTransaction): number[] {
  return unsigned
    .toPsbt()
    .data.inputs.flatMap((input, index) => ((input.partialSig?.length ?? 0) > 0 ? [index] : []));
}

function signerReturning(key: TestKey, sign: (hash: Uint8Array) => Uint8Array): UtxoSigner {
  return { publicKey: key.publicKey, sign };
}

function highS(signature: Uint8Array): Uint8Array {
  const s = BigInt(`0x${Buffer.from(signature.subarray(32)).toString('hex')}`);
  return Uint8Array.from([
    ...signature.subarray(0, 32),
    ...Buffer.from((CURVE_ORDER - s).toString(16).padStart(64, '0'), 'hex'),
  ]);
}

function rejection(run: () => unknown): ChainError {
  try {
    run();
  } catch (err) {
    if (isChainError(err)) return err;
    throw err;
  }
  throw new Error('expected a ChainError');
}

class SingleUtxoTool {
  readonly name = 'single-utxo';

  constructor(private readonly input: UtxoPsbtInput) {}

  async getUtxos(address: string): Promise<UnspentTransactionOutput[]> {
    return address === this.input.utxo.ownerAddress ? [this.input.utxo] : [];
  }
  async getAddressBalance(): Promise<AddressBalance> {
    return { confirmedSats: this.input.utxo.valueSats, unconfirmedSats: 0 };
  }
  async getRawTransactionHex(): Promise<string> {
    return this.input.parentTxHex;
  }
  async getRawTransactionHexBatch(txids: readonly string[]): Promise<string[]> {
    return txids.map(() => this.input.parentTxHex);
  }
  async getTransaction(): Promise<never> {
    throw new Error('not used');
  }
  async getTransactionWithInputs(): Promise<never> {
    throw new Error('not used');
  }
  async getFeeEstimate(): Promise<FeeEstimate> {
    return { satsPerVByte: 10 };
  }
  async broadcast(): Promise<BroadcastResult> {
    throw new Error('not used');
  }
  async getChainTipHeight(): Promise<number> {
    return 100_000;
  }
}

describe('UnsignedUtxoTransaction.signWith', () => {
  it('signs only the inputs the key owns and returns a new transaction each time', () => {
    const unsigned = threeOwnerTransaction();

    const afterOwner1 = unsigned.signWith(owner1.signer);
    const afterOwner2 = afterOwner1.signWith(owner2.signer);

    expect(afterOwner1).toBeInstanceOf(UnsignedUtxoTransaction);
    expect(afterOwner1).not.toBe(unsigned);
    expect(signedInputs(unsigned)).toEqual([]);
    expect(signedInputs(afterOwner1)).toEqual([0]);
    expect(signedInputs(afterOwner2)).toEqual([0, 1]);
    expect(afterOwner2.selectedInputs).toBe(unsigned.selectedInputs);
    expect(afterOwner2.inputsToSign).toBe(unsigned.inputsToSign);
    expect(afterOwner2.feeSats).toBe(unsigned.feeSats);
  });

  it('leaves the transaction unchanged when the same key signs again', () => {
    const once = threeOwnerTransaction().signWith(owner1.signer);

    expect(once.signWith(owner1.signer).psbtBase64).toBe(once.psbtBase64);
  });

  it('throws when the signer owns none of the inputs', () => {
    const unsigned = chain.assembleTransaction({
      inputs: [fundedInput(chain, owner1, 30_000)],
      outputs: [payTo(recipient, 20_000)],
    });

    const err = rejection(() => unsigned.signWith(ownerZ.signer));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('the signer owns none of the inputs');
  });

  it.each([
    ['empty', new Uint8Array(0)],
    ['uncompressed', ecc.pointFromScalar(owner1.privateKey, false)!],
    ['33 bytes but not a point', Uint8Array.from([0x05, ...new Uint8Array(32).fill(0xff)])],
    ['not a byte array', 'public-key' as unknown as Uint8Array],
  ])('rejects a signer whose publicKey is %s', (_label, publicKey) => {
    const err = rejection(() => threeOwnerTransaction().signWith({ publicKey, sign: owner1.signer.sign }));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('33-byte compressed secp256k1 public key');
  });

  it('rejects a signature that is not 64 bytes', () => {
    const shortSigner = signerReturning(owner1, (hash) => ecc.sign(hash, owner1.privateKey).subarray(0, 63));

    const err = rejection(() => threeOwnerTransaction().signWith(shortSigner));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('64-byte compact ECDSA signature');
  });

  it('wraps a signer failure with the input index', () => {
    const failingSigner = signerReturning(owner1, () => {
      throw new Error('hsm unavailable');
    });

    const err = rejection(() => threeOwnerTransaction().signWith(failingSigner));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('signing input 0 failed: hsm unavailable');
  });

  it('signs a P2PKH input with its key', () => {
    const unsigned = chain.assembleTransaction({
      inputs: [fundedInput(chain, owner1, 30_000, UtxoScriptTypes.P2PKH), fundedInput(chain, owner2, 30_000)],
      outputs: [payTo(recipient, 55_000)],
    });

    const { hex } = unsigned.signWith(owner1.signer).signWith(owner2.signer).finalize();

    const tx = Transaction.fromHex(hex);
    expect(tx.ins[0].script.length).toBeGreaterThan(0);
    expect(tx.ins[0].witness).toEqual([]);
    expect(tx.ins[1].witness).toHaveLength(2);
  });

  it('never signs a Taproot input, even one keyed by the same key', () => {
    const taprootAddress = payments.p2tr({
      internalPubkey: owner1.publicKey.subarray(1),
      network: chain.params.networkInfo,
    }).address!;
    const taprootScriptHex = Buffer.from(payments.p2tr({ address: taprootAddress, network: chain.params.networkInfo }).output!).toString('hex');
    const parentTxHex = fundingTransactionHex([{ scriptPubKeyHex: taprootScriptHex, valueSats: 30_000 }]);
    const unsigned = chain.assembleTransaction({
      inputs: [fundedInput(chain, owner1, 30_000), { utxo: utxoFromRawTransaction(parentTxHex, 0, taprootAddress), parentTxHex }],
      outputs: [payTo(recipient, 55_000)],
    });

    const signed = unsigned.signWith(owner1.signer);

    expect(signedInputs(signed)).toEqual([0]);
    expect(rejection(() => signed.finalize()).message).toContain('finalize: input 1 is not signed');
  });

  it('signs and finalizes a transaction built by createTransferUnsignedTransaction', async () => {
    const funded = fundedInput(chain, owner1, 200_000);
    const tool = new SingleUtxoTool(funded);
    const transferChain = bitcoinTestnetChain({
      chainId: chain.chainId,
      utxoProvider: tool,
      rawTxProvider: tool,
      feeEstimator: tool,
      broadcaster: tool,
      chainTipProvider: tool,
    });

    const unsigned = await transferChain.createTransferUnsignedTransaction({
      from: funded.utxo.ownerAddress,
      to: recipient,
      amount: 50_000n,
      tokenIdentifier: undefined,
    });
    const { hex, txid } = unsigned.signWith(owner1.signer).finalize();

    const tx = Transaction.fromHex(hex);
    expect(tx.getId()).toBe(txid);
    expect(Buffer.from(tx.ins[0].hash).reverse().toString('hex')).toBe(funded.utxo.txid);
    expect(tx.outs[0].value).toBe(50_000n);
  });
});

describe('UnsignedUtxoTransaction.finalize', () => {
  it('returns the hex, txid and vsize of the fully signed transaction, without changing it', () => {
    const unsigned = threeOwnerTransaction();
    const signed = unsigned.signWith(owner1.signer).signWith(owner2.signer).signWith(ownerZ.signer);

    const finalized = signed.finalize();

    const tx = Transaction.fromHex(finalized.hex);
    const psbt = unsigned.toPsbt();
    expect(tx.ins.map((i) => [Buffer.from(i.hash).toString('hex'), i.index, i.sequence])).toEqual(
      psbt.txInputs.map((i) => [Buffer.from(i.hash).toString('hex'), i.index, i.sequence]),
    );
    expect(tx.outs.map((o) => [Buffer.from(o.script).toString('hex'), o.value])).toEqual(
      psbt.txOutputs.map((o) => [Buffer.from(o.script).toString('hex'), o.value]),
    );
    expect(tx.ins.every((i) => i.witness.length === 2)).toBe(true);
    expect(finalized.txid).toBe(tx.getId());
    expect(finalized.vsize).toBe(tx.virtualSize());
    expect(signed.finalize()).toEqual(finalized);
    expect(signed.toPsbt().data.inputs.every((i) => i.finalScriptWitness === undefined)).toBe(true);
  });

  it('names the first unsigned input', () => {
    const partlySigned = threeOwnerTransaction().signWith(owner1.signer).signWith(owner2.signer);

    const err = rejection(() => partlySigned.finalize());

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('finalize: input 2 is not signed');
  });

  it('rejects a signature that does not verify', () => {
    const wrongMessageSigner = signerReturning(owner1, (hash) =>
      ecc.sign(Uint8Array.from(hash).reverse(), owner1.privateKey),
    );
    const unsigned = threeOwnerTransaction().signWith(wrongMessageSigner).signWith(owner2.signer).signWith(ownerZ.signer);

    const err = rejection(() => unsigned.finalize());

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('finalize: input 0 has an invalid signature');
  });

  it('rejects a high-S signature', () => {
    const highSSigner = signerReturning(owner2, (hash) => highS(ecc.sign(hash, owner2.privateKey)));
    const unsigned = threeOwnerTransaction().signWith(owner1.signer).signWith(highSSigner).signWith(ownerZ.signer);

    const err = rejection(() => unsigned.finalize());

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('finalize: input 1 has an invalid signature');
  });

  it('refuses a fee rate at or above the 5000 sat/vB safety cap', () => {
    const unsigned = chain.assembleTransaction({
      inputs: [fundedInput(chain, owner1, 2_000_000)],
      outputs: [payTo(recipient, 546)],
    });

    const err = rejection(() => unsigned.signWith(owner1.signer).finalize());

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('finalize:');
    expect(err.message).toContain('fees');
  });
});

describe('UnsignedUtxoTransaction parent checks', () => {
  function countingSigner(key: TestKey): { signer: UtxoSigner; calls: () => number } {
    let calls = 0;
    return {
      signer: signerReturning(key, (hash) => {
        calls += 1;
        return ecc.sign(hash, key.privateKey);
      }),
      calls: () => calls,
    };
  }

  function rebuilt(
    unsigned: UnsignedUtxoTransaction,
    mutate: (psbt: ReturnType<UnsignedUtxoTransaction['toPsbt']>) => void,
    overrides: { feeSats?: number } = {},
  ): UnsignedUtxoTransaction {
    const psbt = unsigned.toPsbt();
    mutate(psbt);
    return new UnsignedUtxoTransaction({
      chainId: unsigned.chainId,
      params: unsigned.params,
      psbtBase64: psbt.toBase64(),
      selectedInputs: unsigned.selectedInputs,
      feeSats: overrides.feeSats ?? unsigned.feeSats,
      feeRateSatsPerVByte: unsigned.feeRateSatsPerVByte,
      estimatedVBytes: unsigned.estimatedVBytes,
      totalInputSats: unsigned.totalInputSats,
      totalOutputSats: unsigned.totalOutputSats,
      changeAddress: unsigned.changeAddress,
      inputsToSign: { ...unsigned.inputsToSign },
    });
  }

  async function transferWithMisreportedValue(scriptType: typeof UtxoScriptTypes.P2WPKH | typeof UtxoScriptTypes.P2PKH) {
    const real = fundedInput(chain, owner1, 10_000_000, scriptType);
    const tool = new SingleUtxoTool({ ...real, utxo: { ...real.utxo, valueSats: 200_000 } });
    const transferChain = bitcoinTestnetChain({
      chainId: chain.chainId,
      utxoProvider: tool,
      rawTxProvider: tool,
      feeEstimator: tool,
      broadcaster: tool,
      chainTipProvider: tool,
    });
    return transferChain.createTransferUnsignedTransaction({
      from: real.utxo.ownerAddress,
      to: recipient,
      amount: 50_000n,
      tokenIdentifier: undefined,
    });
  }

  it('refuses to sign a segwit input whose declared amount is lower than its parent output, before calling the signer', async () => {
    const unsigned = await transferWithMisreportedValue(UtxoScriptTypes.P2WPKH);
    const { signer, calls } = countingSigner(owner1);

    const err = rejection(() => unsigned.signWith(signer));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('signWith: input 0 declares 200000 sats, but its parent output holds 10000000 sats');
    expect(calls()).toBe(0);
  });

  it('refuses to sign a legacy input whose real fee differs from the reported fee, before calling the signer', async () => {
    const unsigned = await transferWithMisreportedValue(UtxoScriptTypes.P2PKH);
    const { signer, calls } = countingSigner(owner1);

    const err = rejection(() => unsigned.signWith(signer));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain(`not the reported ${unsigned.feeSats} sats`);
    expect(err.message).toContain(`would pay ${9_800_000 + unsigned.feeSats} sats in fees`);
    expect(calls()).toBe(0);
  });

  it('refuses to finalize a signed transaction whose declared amount was changed afterwards', () => {
    const signed = threeOwnerTransaction().signWith(owner1.signer).signWith(owner2.signer).signWith(ownerZ.signer);
    const tampered = rebuilt(signed, (psbt) => {
      psbt.data.inputs[0].witnessUtxo = { ...psbt.data.inputs[0].witnessUtxo!, value: 1_000n };
    });

    const err = rejection(() => tampered.finalize());

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('finalize: input 0 declares 1000 sats, but its parent output holds 30000 sats');
  });

  it('refuses to finalize when the reported fee is not the real fee', () => {
    const signed = threeOwnerTransaction().signWith(owner1.signer).signWith(owner2.signer).signWith(ownerZ.signer);

    const err = rejection(() => rebuilt(signed, () => undefined, { feeSats: signed.feeSats - 1 }).finalize());

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain(`finalize: the transaction would pay ${signed.feeSats} sats in fees, not the reported ${signed.feeSats - 1} sats`);
  });

  it('refuses a declared script that differs from the parent output', () => {
    const other = fundedInput(chain, owner2, 30_000);
    const tampered = rebuilt(threeOwnerTransaction(), (psbt) => {
      psbt.data.inputs[0].witnessUtxo = { script: Transaction.fromHex(other.parentTxHex).outs[0].script, value: 30_000n };
    });

    const err = rejection(() => tampered.signWith(owner2.signer));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('signWith: input 0 declares a script that differs from its parent output');
  });

  it('refuses an input without its parent transaction', () => {
    const tampered = rebuilt(threeOwnerTransaction(), (psbt) => {
      delete psbt.data.inputs[1].nonWitnessUtxo;
    });

    const err = rejection(() => tampered.signWith(owner1.signer));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('signWith: input 1 carries no parent transaction (nonWitnessUtxo)');
  });

  it('refuses a parent transaction that is not the one the input spends', () => {
    const other = fundedInput(chain, owner1, 30_000);
    const tampered = rebuilt(threeOwnerTransaction(), (psbt) => {
      psbt.data.inputs[0].nonWitnessUtxo = Buffer.from(other.parentTxHex, 'hex');
    });

    const err = rejection(() => tampered.signWith(owner1.signer));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('signWith: input 0 has a parent transaction that is not the one it spends');
  });
});
