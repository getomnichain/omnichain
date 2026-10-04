import { ChainError, ChainErrorKinds, isChainError } from '../../errors.ts';
import { BtcChain } from '../btc/btc_chain.ts';
import { BITCOIN_TESTNET_PARAMS } from '../btc/network_params.ts';
import { estimateTxVBytes } from '../fee.ts';
import { utxoFromRawTransaction } from '../raw_transaction.ts';
import { UtxoScriptTypes } from '../script.ts';
import { UtxoPsbtInput, UtxoPsbtOutput } from '../utxo.ts';
import { FINAL_SEQUENCE, RBF_SEQUENCE } from '../utxo_network_params.ts';

import { TestKey, fundedInput, fundingTransactionHex, offlineChain, scriptHexFor } from './multisigner_helpers.ts';

const chain = offlineChain();
const owner1 = TestKey.fromByte(0x11);
const owner2 = TestKey.fromByte(0x22);
const recipient = chain.addressForPublicKey(TestKey.fromByte(0x33).publicKey);
const owner1Address = chain.addressForPublicKey(owner1.publicKey);
const owner2Address = chain.addressForPublicKey(owner2.publicKey);

function rejection(run: () => unknown): ChainError {
  try {
    run();
  } catch (err) {
    if (isChainError(err)) return err;
    throw err;
  }
  throw new Error('expected a ChainError');
}

function payTo(address: string, valueSats: number): UtxoPsbtOutput {
  return { kind: 'address', address, valueSats };
}

describe('UtxoChain.assembleTransaction', () => {
  it('lays out the given inputs and outputs in order, with fee, size and owners', () => {
    const a = fundedInput(chain, owner1, 30_000);
    const b = fundedInput(chain, owner2, 40_000);
    const c = fundedInput(chain, owner1, 50_000);

    const unsigned = chain.assembleTransaction({
      inputs: [a, b, c],
      outputs: [
        payTo(recipient, 100_000),
        payTo(owner2Address, 15_000),
        { kind: 'opReturn', data: Uint8Array.of(0xde, 0xad) },
      ],
    });

    expect(unsigned.selectedInputs).toEqual([a.utxo, b.utxo, c.utxo]);
    const psbt = unsigned.toPsbt();
    expect(psbt.txInputs.map((i) => [Buffer.from(i.hash).reverse().toString('hex'), i.index])).toEqual(
      [a, b, c].map(({ utxo }) => [utxo.txid, utxo.vout]),
    );
    psbt.data.inputs.forEach((input, index) => {
      const { utxo, parentTxHex } = [a, b, c][index];
      expect(Buffer.from(input.nonWitnessUtxo!).toString('hex')).toBe(parentTxHex);
      expect(input.witnessUtxo?.value).toBe(BigInt(utxo.valueSats));
    });
    expect(psbt.txOutputs.map((o) => [Buffer.from(o.script).toString('hex'), o.value])).toEqual([
      [scriptHexFor(chain, recipient), 100_000n],
      [scriptHexFor(chain, owner2Address), 15_000n],
      ['6a02dead', 0n],
    ]);

    const estimatedVBytes = estimateTxVBytes(
      [UtxoScriptTypes.P2WPKH, UtxoScriptTypes.P2WPKH, UtxoScriptTypes.P2WPKH],
      [UtxoScriptTypes.P2WPKH, UtxoScriptTypes.P2WPKH],
      [2],
    );
    expect(unsigned.totalInputSats).toBe(120_000);
    expect(unsigned.totalOutputSats).toBe(115_000);
    expect(unsigned.feeSats).toBe(5_000);
    expect(unsigned.estimatedVBytes).toBe(estimatedVBytes);
    expect(unsigned.feeRateSatsPerVByte).toBe(5_000 / estimatedVBytes);
    expect(unsigned.inputsToSign).toEqual({ [owner1Address]: [0, 2], [owner2Address]: [1] });
    expect(unsigned.changeAddress).toBeNull();
  });

  it('sets witnessUtxo only on segwit inputs', () => {
    const legacy = fundedInput(chain, owner1, 30_000, UtxoScriptTypes.P2PKH);
    const segwit = fundedInput(chain, owner2, 30_000);

    const psbt = chain
      .assembleTransaction({ inputs: [legacy, segwit], outputs: [payTo(recipient, 50_000)] })
      .toPsbt();

    expect(psbt.data.inputs[0].nonWitnessUtxo).toBeDefined();
    expect(psbt.data.inputs[0].witnessUtxo).toBeUndefined();
    expect(psbt.data.inputs[1].witnessUtxo).toBeDefined();
  });

  it('accepts several inputs from the same parent transaction', () => {
    const parentTxHex = fundingTransactionHex([
      { scriptPubKeyHex: scriptHexFor(chain, owner1Address), valueSats: 20_000 },
      { scriptPubKeyHex: scriptHexFor(chain, owner1Address), valueSats: 30_000 },
    ]);
    const inputs = [0, 1].map((vout) => ({ utxo: utxoFromRawTransaction(parentTxHex, vout, owner1Address), parentTxHex }));

    const unsigned = chain.assembleTransaction({ inputs, outputs: [payTo(recipient, 49_000)] });

    expect(unsigned.inputsToSign).toEqual({ [owner1Address]: [0, 1] });
    expect(unsigned.feeSats).toBe(1_000);
  });

  it.each([
    ['true', true, RBF_SEQUENCE],
    ['false', false, FINAL_SEQUENCE],
    ['omitted, following the chain default', undefined, RBF_SEQUENCE],
  ])('sets the input sequence from rbfEnabled %s', (_label, rbfEnabled, sequence) => {
    const unsigned = chain.assembleTransaction({
      inputs: [fundedInput(chain, owner1, 30_000), fundedInput(chain, owner2, 30_000)],
      outputs: [payTo(recipient, 50_000)],
      ...(rbfEnabled === undefined ? {} : { rbfEnabled }),
    });

    expect(unsigned.toPsbt().txInputs.map((i) => i.sequence)).toEqual([sequence, sequence]);
  });

  it('follows a chain built with rbfEnabled false when the request omits it', () => {
    const finalChain = new BtcChain({
      chainId: chain.chainId,
      name: 'Bitcoin Testnet',
      params: BITCOIN_TESTNET_PARAMS,
      nativeSymbol: 'tBTC',
      utxoProvider: chain.utxoProvider,
      rawTxProvider: chain.rawTxProvider,
      feeEstimator: chain.feeEstimator,
      broadcaster: chain.broadcaster,
      chainTipProvider: chain.chainTipProvider,
      walletExplorerUrlTemplate: '{wallet_address}',
      transactionExplorerUrlTemplate: '{tx_hash}',
      rbfEnabled: false,
    });

    const unsigned = finalChain.assembleTransaction({
      inputs: [fundedInput(finalChain, owner1, 30_000)],
      outputs: [payTo(recipient, 20_000)],
    });

    expect(unsigned.toPsbt().txInputs[0].sequence).toBe(FINAL_SEQUENCE);
  });
});

describe('UtxoChain.assembleTransaction input checks', () => {
  const output = [payTo(recipient, 10_000)];

  function inputRejection(input: UtxoPsbtInput): ChainError {
    return rejection(() =>
      chain.assembleTransaction({ inputs: [fundedInput(chain, owner2, 20_000), input], outputs: output }),
    );
  }

  it('rejects a parent transaction that is not the one utxo.txid names', () => {
    const a = fundedInput(chain, owner1, 20_000);
    const b = fundedInput(chain, owner1, 20_000);

    const err = inputRejection({ utxo: a.utxo, parentTxHex: b.parentTxHex });

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('inputs[1]');
    expect(err.message).toContain(a.utxo.txid);
  });

  it.each([
    ['not hex', 'zz'],
    ['empty', ''],
    ['hex that is not a transaction', 'deadbeef'],
  ])('rejects a parentTxHex that is %s', (_label, parentTxHex) => {
    const { utxo } = fundedInput(chain, owner1, 20_000);

    const err = inputRejection({ utxo, parentTxHex });

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('inputs[1].parentTxHex');
  });

  it.each([
    ['beyond the parent outputs', 1],
    ['negative', -1],
  ])('rejects a vout %s', (_label, vout) => {
    const { utxo, parentTxHex } = fundedInput(chain, owner1, 20_000);

    const err = inputRejection({ utxo: { ...utxo, vout }, parentTxHex });

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain(`no output ${vout}`);
  });

  it('rejects a valueSats that differs from the parent output', () => {
    const { utxo, parentTxHex } = fundedInput(chain, owner1, 20_000);

    const err = inputRejection({ utxo: { ...utxo, valueSats: 20_001 }, parentTxHex });

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('utxo.valueSats 20001 does not match the parent output value 20000');
  });

  it('rejects a scriptPubKeyHex that differs from the parent output', () => {
    const { utxo, parentTxHex } = fundedInput(chain, owner1, 20_000);

    const err = inputRejection({ utxo: { ...utxo, scriptPubKeyHex: scriptHexFor(chain, owner2Address) }, parentTxHex });

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('utxo.scriptPubKeyHex does not match the parent output script');
  });

  it('rejects an ownerAddress that does not own the spent output', () => {
    const { utxo, parentTxHex } = fundedInput(chain, owner1, 20_000);

    const err = inputRejection({ utxo: { ...utxo, ownerAddress: owner2Address }, parentTxHex });

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain(`utxo.ownerAddress ${owner2Address} does not own the output it spends`);
  });

  it.each([
    ['not an address', 'not-an-address'],
    ['a mainnet address', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
  ])('rejects an ownerAddress that is %s with InvalidAddress', (_label, ownerAddress) => {
    const { utxo, parentTxHex } = fundedInput(chain, owner1, 20_000);

    const err = inputRejection({ utxo: { ...utxo, ownerAddress }, parentTxHex });

    expect(err.kind).toBe(ChainErrorKinds.InvalidAddress);
    expect(err.meta.address).toBe(ownerAddress);
  });

  it('rejects an input that spends an OP_RETURN output', () => {
    const parentTxHex = fundingTransactionHex([{ scriptPubKeyHex: '6a02dead', valueSats: 20_000 }]);

    const err = inputRejection({ utxo: utxoFromRawTransaction(parentTxHex, 0, owner1Address), parentTxHex });

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('cannot spend an output of script type op_return');
  });

  it('rejects the same outpoint spent twice', () => {
    const a = fundedInput(chain, owner1, 20_000);

    const err = rejection(() => chain.assembleTransaction({ inputs: [a, a], outputs: output }));

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain(`inputs[1] spends ${a.utxo.txid}:0 a second time`);
  });
});

describe('UtxoChain.assembleTransaction output and total checks', () => {
  const input = fundedInput(chain, owner1, 20_000);

  function outputsRejection(outputs: UtxoPsbtOutput[], inputs: UtxoPsbtInput[] = [input]): ChainError {
    return rejection(() => chain.assembleTransaction({ inputs, outputs }));
  }

  it('rejects an empty input list', () => {
    const err = outputsRejection([payTo(recipient, 10_000)], []);

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('at least one input');
  });

  it('rejects an empty output list', () => {
    const err = outputsRejection([]);

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('at least one output');
  });

  it.each([
    ['below dust', 545],
    ['not an integer', 1_000.5],
    ['above the safe integer range', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects an address output whose valueSats is %s', (_label, valueSats) => {
    const err = outputsRejection([payTo(recipient, valueSats)]);

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('outputs[0].valueSats');
  });

  it('accepts an address output of exactly the dust value', () => {
    expect(() => chain.assembleTransaction({ inputs: [input], outputs: [payTo(recipient, 546)] })).not.toThrow();
  });

  it.each([
    ['not an address', 'tb1q-not-an-address'],
    ['a mainnet address', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
    ['an address with a bad checksum', 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsy'],
  ])('rejects an output address that is %s with InvalidAddress', (_label, address) => {
    const err = outputsRejection([payTo(address, 10_000)]);

    expect(err.kind).toBe(ChainErrorKinds.InvalidAddress);
    expect(err.message).toContain('outputs[0].address');
  });

  it('rejects OP_RETURN data over 80 bytes and accepts exactly 80 and 0', () => {
    const err = outputsRejection([{ kind: 'opReturn', data: new Uint8Array(81) }]);

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('outputs[0].data');
    for (const length of [80, 0]) {
      expect(() =>
        chain.assembleTransaction({
          inputs: [input],
          outputs: [payTo(recipient, 10_000), { kind: 'opReturn', data: new Uint8Array(length) }],
        }),
      ).not.toThrow();
    }
  });

  it('rejects OP_RETURN data that is not a byte array', () => {
    const err = outputsRejection([{ kind: 'opReturn', data: 'memo' as unknown as Uint8Array }]);

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
  });

  it('rejects a second OP_RETURN output', () => {
    const err = outputsRejection([
      { kind: 'opReturn', data: Uint8Array.of(1) },
      { kind: 'opReturn', data: Uint8Array.of(2) },
    ]);

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('at most one opReturn output');
  });

  it('rejects an unknown output kind', () => {
    const err = outputsRejection([{ kind: 'script', script: '51' } as unknown as UtxoPsbtOutput]);

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain("outputs[0].kind must be 'address' or 'opReturn', got script");
  });

  it('rejects outputs that exceed the inputs and accepts a zero fee', () => {
    const err = outputsRejection([payTo(recipient, 20_001)]);

    expect(err.kind).toBe(ChainErrorKinds.InvalidArgument);
    expect(err.message).toContain('outputs total 20001 sats but inputs only 20000 sats');
    expect(chain.assembleTransaction({ inputs: [input], outputs: [payTo(recipient, 20_000)] }).feeSats).toBe(0);
  });
});
