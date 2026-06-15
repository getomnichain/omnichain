import { networks, payments } from 'bitcoinjs-lib';
import * as bitcoinMessage from 'bitcoinjs-message';
import { ECPairFactory } from 'ecpair';
import * as ecc from 'tiny-secp256k1';

import { bitcoinMainnetChain, bitcoinTestnetChain } from '../btc_chains.ts';
import {
  AddressBalance,
  BroadcastResult,
  FeeEstimate,
  RawTransactionView,
  UnspentTransactionOutput,
} from '../../utxo.ts';
import { UtxoBroadcaster } from '../../tools/broadcaster.ts';
import { UtxoChainTipProvider } from '../../tools/chain_tip_provider.ts';
import { UtxoFeeEstimator } from '../../tools/fee_estimator.ts';
import { UtxoRawTransactionProvider } from '../../tools/raw_transaction_provider.ts';
import { UtxoProvider } from '../../tools/utxo_provider.ts';

class FakeTool implements UtxoProvider, UtxoRawTransactionProvider, UtxoFeeEstimator, UtxoBroadcaster, UtxoChainTipProvider {
  get name(): string {
    return 'fake';
  }
  async getUtxos(): Promise<UnspentTransactionOutput[]> {
    return [];
  }
  async getAddressBalance(): Promise<AddressBalance> {
    return { confirmedSats: 0, unconfirmedSats: 0 };
  }
  async getTransaction(): Promise<RawTransactionView> {
    throw new Error('not implemented');
  }
  async estimateFeeRate(): Promise<FeeEstimate> {
    return { satsPerVByte: 1 };
  }
  async broadcast(): Promise<BroadcastResult> {
    throw new Error('not implemented');
  }
  async getChainTipHeight(): Promise<number> {
    return 0;
  }
}

function makeChain(testnet: boolean) {
  const tool = new FakeTool();
  const factory = testnet ? bitcoinTestnetChain : bitcoinMainnetChain;
  return factory({
    chainId: testnet ? -2 : -1,
    utxoProvider: tool,
    rawTxProvider: tool,
    feeEstimator: tool,
    broadcaster: tool,
    chainTipProvider: tool,
  });
}

const ECPair = ECPairFactory(ecc);

function p2pkh(pubkey: Buffer, network: networks.Network): string {
  const addr = payments.p2pkh({ pubkey, network }).address;
  if (!addr) throw new Error('failed to derive p2pkh address');
  return addr;
}

describe('UtxoChain.verifyMessageSignature (BTC)', () => {
  const message = 'Pluton login nonce 7f3a2c91';
  const keyPair = ECPair.fromPrivateKey(Buffer.alloc(32, 0xaa));
  const compressedPubkey = Buffer.from(keyPair.publicKey);
  const mainnetSigner = p2pkh(compressedPubkey, networks.bitcoin);
  const chain = makeChain(false);

  function signLegacy(net: networks.Network): string {
    const priv = Buffer.from(keyPair.privateKey!);
    const sig = bitcoinMessage.sign(message, priv, true, net.messagePrefix);
    return sig.toString('base64');
  }

  it('returns true for a valid legacy P2PKH signature', async () => {
    const signature = signLegacy(networks.bitcoin);
    const ok = await chain.verifyMessageSignature({
      message,
      signer: mainnetSigner,
      signature,
    });
    expect(ok).toBe(true);
  });

  it('returns false when the message differs', async () => {
    const signature = signLegacy(networks.bitcoin);
    const ok = await chain.verifyMessageSignature({
      message: message + ' tampered',
      signer: mainnetSigner,
      signature,
    });
    expect(ok).toBe(false);
  });

  it('returns false when the signer differs', async () => {
    const signature = signLegacy(networks.bitcoin);
    const other = ECPair.fromPrivateKey(Buffer.alloc(32, 0xbb));
    const otherSigner = p2pkh(Buffer.from(other.publicKey), networks.bitcoin);
    const ok = await chain.verifyMessageSignature({
      message,
      signer: otherSigner,
      signature,
    });
    expect(ok).toBe(false);
  });

  it('returns false for a malformed signature', async () => {
    const ok = await chain.verifyMessageSignature({
      message,
      signer: mainnetSigner,
      signature: 'not-a-signature',
    });
    expect(ok).toBe(false);
  });

  it('returns false for a malformed signer', async () => {
    const signature = signLegacy(networks.bitcoin);
    const ok = await chain.verifyMessageSignature({
      message,
      signer: 'not-an-address',
      signature,
    });
    expect(ok).toBe(false);
  });

  it('returns false for a signer that fails network address validation', async () => {
    const signature = signLegacy(networks.bitcoin);
    const testnetChain = makeChain(true);
    const ok = await testnetChain.verifyMessageSignature({
      message,
      signer: mainnetSigner,
      signature,
    });
    expect(ok).toBe(false);
  });
});
