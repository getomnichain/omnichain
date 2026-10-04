import {
  AssembleUtxoTransactionRequest,
  FinalizedUtxoTransaction,
  UtxoCoin,
  UtxoNetworkInfo,
  UtxoPsbtInput,
  UtxoScriptTypes,
  UtxoSigner,
  addressToScriptPubKey,
  utxoFromRawTransaction,
} from '../../index.ts';

import { RecordingBroadcaster, TestKey, fundedInput, offlineChain } from './multisigner_helpers.ts';

describe('multi-signer BTC transaction through the public surface', () => {
  it('assembles, signs with two vault keys and an operator key, finalizes and broadcasts', async () => {
    const broadcaster = new RecordingBroadcaster();
    const chain = offlineChain(UtxoCoin.BitcoinTestnet, broadcaster);
    const network: UtxoNetworkInfo = chain.params.networkInfo;
    const [vaultA, vaultB, operator] = [0x51, 0x52, 0x53].map((byte) => TestKey.fromByte(byte));
    const [vaultAAddress, vaultBAddress, operatorAddress] = [vaultA, vaultB, operator].map((key) =>
      chain.addressForPublicKey(key.publicKey),
    );
    const recipient = chain.addressForPublicKey(TestKey.fromByte(0x54).publicKey);
    const memo = new TextEncoder().encode('action-42');
    const inputs: UtxoPsbtInput[] = [
      fundedInput(chain, vaultA, 60_000),
      fundedInput(chain, vaultB, 40_000),
      fundedInput(chain, operator, 20_000),
    ];
    const request: AssembleUtxoTransactionRequest = {
      inputs,
      outputs: [
        { kind: 'address', address: recipient, valueSats: 90_000 },
        { kind: 'address', address: vaultBAddress, valueSats: 10_000 },
        { kind: 'address', address: operatorAddress, valueSats: 18_500 },
        { kind: 'opReturn', data: memo },
      ],
    };
    const signers: UtxoSigner[] = [vaultA.signer, vaultB.signer, operator.signer];

    const unsigned = chain.assembleTransaction(request);
    const finalized: FinalizedUtxoTransaction = signers.reduce((tx, signer) => tx.signWith(signer), unsigned).finalize();
    const txid = await chain.broadcast(finalized.hex);

    expect(unsigned.feeSats).toBe(1_500);
    expect(unsigned.inputsToSign).toEqual({ [vaultAAddress]: [0], [vaultBAddress]: [1], [operatorAddress]: [2] });
    const paid = [recipient, vaultBAddress, operatorAddress].map((address, vout) =>
      utxoFromRawTransaction(finalized.hex, vout, address),
    );
    expect(paid.map((o) => [o.txid, o.valueSats, o.scriptPubKeyHex])).toEqual([
      [finalized.txid, 90_000, Buffer.from(addressToScriptPubKey(recipient, network)).toString('hex')],
      [finalized.txid, 10_000, Buffer.from(addressToScriptPubKey(vaultBAddress, network)).toString('hex')],
      [finalized.txid, 18_500, Buffer.from(addressToScriptPubKey(operatorAddress, network)).toString('hex')],
    ]);
    const memoOutput = utxoFromRawTransaction(finalized.hex, 3, recipient);
    expect(memoOutput.scriptType).toBe(UtxoScriptTypes.OpReturn);
    expect(memoOutput.scriptPubKeyHex).toBe(`6a09${Buffer.from(memo).toString('hex')}`);
    expect(Math.abs(finalized.vsize - unsigned.estimatedVBytes)).toBeLessThanOrEqual(2);
    expect(broadcaster.broadcasted).toEqual([finalized.hex]);
    expect(txid).toBe('broadcast-1');
  });
});
