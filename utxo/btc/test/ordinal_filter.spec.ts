import { Transaction, networks } from 'bitcoinjs-lib';



import '../../ecc.ts';
import { addressToScriptPubKey, UtxoScriptTypes } from '../../script.ts';
import { UtxoBroadcaster } from '../../tools/broadcaster.ts';
import { UtxoChainTipProvider } from '../../tools/chain_tip_provider.ts';
import { UtxoFeeEstimator } from '../../tools/fee_estimator.ts';
import { UtxoRawTransactionProvider } from '../../tools/raw_transaction_provider.ts';
import { UtxoProvider } from '../../tools/utxo_provider.ts';
import {
  AddressBalance,
  BroadcastResult,
  FeeEstimate,
  RawTransactionView,
  UnspentTransactionOutput,
} from '../../utxo.ts';
import { bitcoinTestnetChain } from '../btc_chains.ts';
import { AssetBearingOutpoint } from '../tools/asset_outpoint.ts';
import { BtcInscriptionIndex } from '../tools/inscription_index.ts';
import { BtcRareSatIndex } from '../tools/rare_sat_index.ts';
import { BtcRuneIndex } from '../tools/rune_index.ts';

const SENDER_TESTNET_P2WPKH = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const RECIPIENT_TESTNET_P2WPKH = 'tb1q9h0yjdupyfpxfjg24rpx755xrplvzd9hz2nj7v';

function parentHexFor(valueSats: number, owner: string): string {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff);
  tx.addOutput(
    Buffer.from(addressToScriptPubKey(owner, networks.testnet)),
    BigInt(valueSats)
  );
  return tx.toHex();
}

function utxoAt(value: number, vout: number, owner: string) {
  const hex = parentHexFor(value, owner);
  const txid = Transaction.fromHex(hex).getId();
  const scriptPubKey = Buffer.from(addressToScriptPubKey(owner, networks.testnet)).toString('hex');
  const utxo: UnspentTransactionOutput = {
    txid,
    vout,
    valueSats: value,
    scriptPubKeyHex: scriptPubKey,
    scriptType: UtxoScriptTypes.P2WPKH,
    confirmations: 6,
    ownerAddress: owner,
  };
  return { utxo, hex };
}

class FakeTool
  implements
    UtxoProvider,
    UtxoRawTransactionProvider,
    UtxoFeeEstimator,
    UtxoBroadcaster,
    UtxoChainTipProvider
{
  utxos: UnspentTransactionOutput[] = [];
  parentByTxid = new Map<string, string>();
  get name(): string {
    return 'fake';
  }
  async getUtxos(): Promise<UnspentTransactionOutput[]> {
    return this.utxos;
  }
  async getAddressBalance(): Promise<AddressBalance> {
    return { confirmedSats: this.utxos.reduce((s, u) => s + u.valueSats, 0), unconfirmedSats: 0 };
  }
  async getRawTransactionHex(txid: string): Promise<string> {
    const hex = this.parentByTxid.get(txid);
    if (!hex) throw new Error(`unknown txid ${txid}`);
    return hex;
  }
  async getRawTransactionHexBatch(txids: readonly string[]): Promise<string[]> {
    return Promise.all(txids.map((t) => this.getRawTransactionHex(t)));
  }
  async getTransaction(_txid: string): Promise<RawTransactionView> {
    throw new Error('unused');
  }
  async getFeeEstimate(_: number): Promise<FeeEstimate> {
    return { satsPerVByte: 10 };
  }
  async broadcast(_: string): Promise<BroadcastResult> {
    return { txid: 'x' };
  }
  async getChainTipHeight(): Promise<number> {
    return 100_000;
  }
}

class FakeInscriptionIndex implements BtcInscriptionIndex {
  tainted: AssetBearingOutpoint[] = [];
  callsByAddress: string[] = [];
  get name(): string {
    return 'fake-inscription';
  }
  async outpointsWithInscriptions(address: string): Promise<readonly AssetBearingOutpoint[]> {
    this.callsByAddress.push(address);
    return this.tainted;
  }
}

class FakeRuneIndex implements BtcRuneIndex {
  tainted: AssetBearingOutpoint[] = [];
  callsByAddress: string[] = [];
  get name(): string {
    return 'fake-rune';
  }
  async outpointsWithRunes(address: string): Promise<readonly AssetBearingOutpoint[]> {
    this.callsByAddress.push(address);
    return this.tainted;
  }
}

class FakeRareSatIndex implements BtcRareSatIndex {
  tainted: AssetBearingOutpoint[] = [];
  callsByAddress: string[] = [];
  get name(): string {
    return 'fake-rare-sat';
  }
  async outpointsWithRareSats(address: string): Promise<readonly AssetBearingOutpoint[]> {
    this.callsByAddress.push(address);
    return this.tainted;
  }
}

interface FixtureOptions {
  withInscriptionIndex?: boolean;
  withRuneIndex?: boolean;
  withRareSatIndex?: boolean;
}

function buildFixture(opts: FixtureOptions = {}) {
  const tool = new FakeTool();
  const a = utxoAt(200_000, 0, SENDER_TESTNET_P2WPKH);
  const b = utxoAt(50_000, 1, SENDER_TESTNET_P2WPKH);
  tool.utxos = [a.utxo, b.utxo];
  tool.parentByTxid.set(a.utxo.txid, a.hex);
  tool.parentByTxid.set(b.utxo.txid, b.hex);
  const inscriptionIndex = opts.withInscriptionIndex ? new FakeInscriptionIndex() : undefined;
  const runeIndex = opts.withRuneIndex ? new FakeRuneIndex() : undefined;
  const rareSatIndex = opts.withRareSatIndex ? new FakeRareSatIndex() : undefined;
  const chain = bitcoinTestnetChain({
    chainId: -2,
    utxoProvider: tool,
    rawTxProvider: tool,
    feeEstimator: tool,
    broadcaster: tool,
    chainTipProvider: tool,
    inscriptionIndex,
    runeIndex,
    rareSatIndex,
  });
  return { tool, chain, inscriptionIndex, runeIndex, rareSatIndex, utxoA: a.utxo, utxoB: b.utxo };
}

describe('BtcChain asset filter on getUtxos', () => {
  it('without any exclude flags, the configured indexes are not consulted', async () => {
    const fx = buildFixture({ withInscriptionIndex: true, withRuneIndex: true });
    await fx.chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 30_000n,
    });
    expect(fx.inscriptionIndex!.callsByAddress).toEqual([]);
    expect(fx.runeIndex!.callsByAddress).toEqual([]);
  });

  it('excludeInscriptions: true calls the inscription index and drops marked UTXOs', async () => {
    const fx = buildFixture({ withInscriptionIndex: true });
    fx.inscriptionIndex!.tainted = [{ txid: fx.utxoA.txid, vout: fx.utxoA.vout }];
    const unsigned = await fx.chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 30_000n,
      excludeInscriptions: true,
    });
    expect(fx.inscriptionIndex!.callsByAddress).toEqual([SENDER_TESTNET_P2WPKH]);
    expect(unsigned.selectedInputs.find((u) => u.txid === fx.utxoA.txid)).toBeUndefined();
    expect(unsigned.selectedInputs.some((u) => u.txid === fx.utxoB.txid)).toBe(true);
  });

  it('excludeRunes: true drops UTXOs marked by the rune index', async () => {
    const fx = buildFixture({ withRuneIndex: true });
    fx.runeIndex!.tainted = [{ txid: fx.utxoB.txid, vout: fx.utxoB.vout }];
    const unsigned = await fx.chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 30_000n,
      excludeRunes: true,
    });
    expect(unsigned.selectedInputs.find((u) => u.txid === fx.utxoB.txid)).toBeUndefined();
  });

  it('unions tainted outpoints across all requested indexes', async () => {
    const fx = buildFixture({
      withInscriptionIndex: true,
      withRuneIndex: true,
      withRareSatIndex: true,
    });
    fx.inscriptionIndex!.tainted = [{ txid: fx.utxoA.txid, vout: fx.utxoA.vout }];
    fx.rareSatIndex!.tainted = [{ txid: fx.utxoB.txid, vout: fx.utxoB.vout }];
    await expect(
      fx.chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        amount: 30_000n,
        excludeInscriptions: true,
        excludeRunes: true,
        excludeRareSats: true,
      })
    ).rejects.toThrow(/no spendable UTXOs/i);
  });

  it('throws if excludeInscriptions is requested but no inscription index was configured', async () => {
    const fx = buildFixture();
    await expect(
      fx.chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        amount: 30_000n,
        excludeInscriptions: true,
      })
    ).rejects.toThrow(/excludeInscriptions requested but no inscriptionIndex/i);
  });

  it('throws if excludeRunes is requested but no rune index was configured', async () => {
    const fx = buildFixture({ withInscriptionIndex: true });
    await expect(
      fx.chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        amount: 30_000n,
        excludeRunes: true,
      })
    ).rejects.toThrow(/excludeRunes requested but no runeIndex/i);
  });

  it('throws if excludeRareSats is requested but no rare sat index was configured', async () => {
    const fx = buildFixture({ withInscriptionIndex: true });
    await expect(
      fx.chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        amount: 30_000n,
        excludeRareSats: true,
      })
    ).rejects.toThrow(/excludeRareSats requested but no rareSatIndex/i);
  });

  it('throws when two excludes are requested and one of the two indexes is missing', async () => {
    const fx = buildFixture({ withInscriptionIndex: true });
    await expect(
      fx.chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        amount: 30_000n,
        excludeInscriptions: true,
        excludeRunes: true,
      })
    ).rejects.toThrow(/excludeRunes requested but no runeIndex/i);
    expect(fx.inscriptionIndex!.callsByAddress).toEqual([]);
  });
});
