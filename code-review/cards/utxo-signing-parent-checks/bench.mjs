import { createHash } from 'node:crypto';

import { Transaction } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

import { CHAIN_ID_BITCOIN_TESTNET } from '../../../dist/esm/chain_ids.js';
import {
  UtxoCoin,
  addressToScriptPubKey,
  utxoChainFromCoin,
  utxoFromRawTransaction,
} from '../../../dist/esm/utxo/index.js';

const BATCHES = [
  { vaults: 50, inputsEach: 1, parentBytes: 21_000, limitSeconds: 2 },
  { vaults: 10, inputsEach: 3, parentBytes: 21_000, limitSeconds: 1 },
  { vaults: 10, inputsEach: 1, parentBytes: 91_000, limitSeconds: 1 },
  { vaults: 50, inputsEach: 1, parentBytes: 91_000, limitSeconds: 5 },
];
const INPUT_SATS = 100_000n;

const offline = async () => {
  throw new Error('offline');
};
const tools = {
  name: 'offline',
  getUtxos: offline,
  getAddressBalance: offline,
  getRawTransactionHex: offline,
  getRawTransactionHexBatch: offline,
  getTransaction: offline,
  getTransactionWithInputs: offline,
  getFeeEstimate: offline,
  broadcast: offline,
  getChainTipHeight: offline,
};
const chain = utxoChainFromCoin({
  coin: UtxoCoin.BitcoinTestnet,
  chainId: CHAIN_ID_BITCOIN_TESTNET,
  utxoProvider: tools,
  rawTxProvider: tools,
  feeEstimator: tools,
  broadcaster: tools,
  chainTipProvider: tools,
});

let counter = 0;
function deterministicBytes(length) {
  const out = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 32) {
    createHash('sha256').update(String(counter++)).digest().copy(out, offset);
  }
  return out;
}

function signerFor(index) {
  const privateKey = new Uint8Array(32);
  privateKey[0] = 7;
  privateKey[31] = index + 1;
  return { publicKey: ecc.pointFromScalar(privateKey, true), sign: (hash) => ecc.sign(hash, privateKey) };
}

function fundedInput(signer, parentBytes) {
  const ownerAddress = chain.addressForPublicKey(signer.publicKey);
  const parent = new Transaction();
  parent.version = 2;
  parent.addInput(deterministicBytes(32), 0);
  parent.addOutput(addressToScriptPubKey(ownerAddress, chain.params.networkInfo), INPUT_SATS);
  const filler = Uint8Array.from(Buffer.concat([Buffer.from('0014', 'hex'), deterministicBytes(20)]));
  const outputBytes = 8 + 1 + filler.length;
  const fillerOutputs = Math.max(0, Math.ceil((parentBytes - parent.byteLength()) / outputBytes));
  for (let i = 0; i < fillerOutputs; i += 1) parent.addOutput(filler, 546n);
  const parentTxHex = parent.toHex();
  return { utxo: utxoFromRawTransaction(parentTxHex, 0, ownerAddress), parentTxHex };
}

function assembled({ vaults, inputsEach, parentBytes }) {
  const signers = Array.from({ length: vaults }, (_, index) => signerFor(index));
  const inputs = signers.flatMap((signer) =>
    Array.from({ length: inputsEach }, () => fundedInput(signer, parentBytes)),
  );
  const operator = signerFor(vaults);
  inputs.push(fundedInput(operator, 0));
  const unsigned = chain.assembleTransaction({
    inputs,
    outputs: [
      {
        kind: 'address',
        address: chain.addressForPublicKey(signerFor(vaults + 1).publicKey),
        valueSats: Number(BigInt(inputs.length) * INPUT_SATS) - 20_000,
      },
    ],
  });
  return { unsigned, signers: [...signers, operator] };
}

function timed(run) {
  const started = performance.now();
  const hex = run();
  return { hex, seconds: (performance.now() - started) / 1000 };
}

function bitcoinjsDirectly(unsigned, signers) {
  const psbt = unsigned.toPsbt();
  return timed(() => {
    for (const signer of signers) psbt.signAllInputs(signer);
    psbt.finalizeAllInputs();
    return psbt.extractTransaction().toHex();
  });
}

function signWithLoop(unsigned, signers) {
  return timed(() => signers.reduce((tx, signer) => tx.signWith(signer), unsigned).finalize().hex);
}

let allPassed = true;
for (const batch of BATCHES) {
  const { unsigned, signers } = assembled(batch);
  const direct = bitcoinjsDirectly(unsigned, signers);
  const loop = signWithLoop(unsigned, signers);
  const sameHex = direct.hex === loop.hex;
  const passed = sameHex && loop.seconds <= batch.limitSeconds;
  allPassed &&= passed;
  console.log(
    `${batch.vaults} x ${batch.inputsEach}, ${batch.parentBytes / 1000} kB: ` +
      `signWith ${loop.seconds.toFixed(1)} s (limit ${batch.limitSeconds} s), ` +
      `bitcoinjs directly ${direct.seconds.toFixed(1)} s, same hex ${sameHex}, ${passed ? 'PASS' : 'FAIL'}`,
  );
}
process.exitCode = allPassed ? 0 : 1;
