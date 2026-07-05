import { Psbt, Transaction, networks } from 'bitcoinjs-lib';



import { bitcoinTestnetChain } from '../btc_chains.ts';

const TEST_CHAIN_ID = -2;
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
import { BITCOIN_TESTNET_PARAMS } from '../network_params.ts';
import { RBF_SEQUENCE } from '../../utxo_network_params.ts';
import { UtxoScriptTypes, addressToScriptPubKey } from '../../script.ts';

const SENDER_TESTNET_P2WPKH = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const RECIPIENT_TESTNET_P2WPKH = 'tb1q9h0yjdupyfpxfjg24rpx755xrplvzd9hz2nj7v';

function buildParentTxHex(utxoValueSats: number, ownerAddress: string): string {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff);
  tx.addOutput(
    Buffer.from(addressToScriptPubKey(ownerAddress, networks.testnet)),
    BigInt(utxoValueSats)
  );
  return tx.toHex();
}

function buildUtxo(value: number, owner: string, vout = 0): {
  utxo: UnspentTransactionOutput;
  parentHex: string;
} {
  const parentHex = buildParentTxHex(value, owner);
  const parentTxid = Transaction.fromHex(parentHex).getId();
  const scriptPubKey = Buffer.from(addressToScriptPubKey(owner, networks.testnet)).toString('hex');
  return {
    utxo: {
      txid: parentTxid,
      vout,
      valueSats: value,
      scriptPubKeyHex: scriptPubKey,
      scriptType: UtxoScriptTypes.P2WPKH,
      confirmations: 6,
      ownerAddress: owner,
    },
    parentHex,
  };
}

class FakeBtcTool
  implements
    UtxoProvider,
    UtxoRawTransactionProvider,
    UtxoFeeEstimator,
    UtxoBroadcaster,
    UtxoChainTipProvider
{
  utxosByAddress = new Map<string, UnspentTransactionOutput[]>();
  rawTxByTxid = new Map<string, string>();
  feeRateSatsPerVByte = 10;
  broadcastedHex: string | null = null;

  get name(): string {
    return 'fake';
  }
  async getUtxos(address: string): Promise<UnspentTransactionOutput[]> {
    return this.utxosByAddress.get(address) ?? [];
  }
  async getAddressBalance(address: string): Promise<AddressBalance> {
    const utxos = await this.getUtxos(address);
    const confirmedSats = utxos.reduce((s, u) => s + u.valueSats, 0);
    return { confirmedSats, unconfirmedSats: 0 };
  }
  async getRawTransactionHex(txid: string): Promise<string> {
    const hex = this.rawTxByTxid.get(txid);
    if (!hex) throw new Error(`unknown txid ${txid}`);
    return hex;
  }
  async getRawTransactionHexBatch(txids: readonly string[]): Promise<string[]> {
    return Promise.all(txids.map((t) => this.getRawTransactionHex(t)));
  }
  async getTransaction(_txid: string): Promise<RawTransactionView> {
    throw new Error('not used');
  }
  async getFeeEstimate(_targetBlocks: number): Promise<FeeEstimate> {
    return { satsPerVByte: this.feeRateSatsPerVByte };
  }
  async broadcast(rawHex: string): Promise<BroadcastResult> {
    this.broadcastedHex = rawHex;
    return { txid: 'broadcast-txid' };
  }
  async getChainTipHeight(): Promise<number> {
    return 100_000;
  }
}

function chainFromTool(tool: FakeBtcTool) {
  return bitcoinTestnetChain({
    chainId: TEST_CHAIN_ID,
    utxoProvider: tool,
    rawTxProvider: tool,
    feeEstimator: tool,
    broadcaster: tool,
    chainTipProvider: tool,
  });
}

function makeChainWithUtxo(senderValueSats: number) {
  const tool = new FakeBtcTool();
  const { utxo, parentHex } = buildUtxo(senderValueSats, SENDER_TESTNET_P2WPKH);
  tool.utxosByAddress.set(SENDER_TESTNET_P2WPKH, [utxo]);
  tool.rawTxByTxid.set(utxo.txid, parentHex);
  const chain = chainFromTool(tool);
  return { chain, tool, utxo };
}

describe('BtcChain — basics', () => {
  it('reports the right native token and identifiers', () => {
    const chain = chainFromTool(new FakeBtcTool());
    expect(chain.chainId).toBe(TEST_CHAIN_ID);
    expect(chain.nativeToken.symbol).toBe('tBTC');
    expect(chain.nativeToken.identifier).toBe(undefined);
    expect(chain.validateTokenIdentifier(undefined)).toBe(true);
    expect(chain.validateTokenIdentifier('0xUSDT')).toBe(false);
  });

  it('validates testnet wallet addresses (and rejects mainnet)', () => {
    const chain = chainFromTool(new FakeBtcTool());
    expect(chain.validateAddress(SENDER_TESTNET_P2WPKH)).toBe(true);
    expect(chain.validateAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
  });

  it('produces explorer URLs from the templates', () => {
    const chain = chainFromTool(new FakeBtcTool());
    expect(chain.getWalletExplorerUrl(SENDER_TESTNET_P2WPKH)).toContain(SENDER_TESTNET_P2WPKH);
    expect(chain.getTransactionExplorerUrl('abc123')).toContain('abc123');
  });
});

describe('BtcChain.createTransferUnsignedTransaction', () => {
  it('builds a PSBT with the recipient + change output and a populated nonWitnessUtxo', async () => {
    const { chain, tool, utxo } = makeChainWithUtxo(200_000);
    const unsigned = await chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 50_000n,
    });

    expect(unsigned.selectedInputs).toHaveLength(1);
    expect(unsigned.selectedInputs[0].txid).toBe(utxo.txid);
    expect(unsigned.feeRateSatsPerVByte).toBe(tool.feeRateSatsPerVByte);
    expect(unsigned.totalInputSats).toBe(200_000);

    const psbt = Psbt.fromBase64(unsigned.psbtBase64, { network: networks.testnet });
    expect(psbt.txInputs).toHaveLength(1);
    expect(psbt.txOutputs.length).toBeGreaterThanOrEqual(2);
    expect(psbt.txInputs[0].sequence).toBe(RBF_SEQUENCE);
    const data = psbt.data.inputs[0];
    expect(data.nonWitnessUtxo).toBeDefined();
    expect(data.witnessUtxo).toBeDefined();
    expect(data.witnessUtxo?.value).toBe(BigInt(utxo.valueSats));

    expect(unsigned.changeAddress).toBe(SENDER_TESTNET_P2WPKH);
    expect(unsigned.totalOutputSats).toBe(50_000 + (unsigned.feeSats === 0 ? 0 : 150_000 - unsigned.feeSats));
  });

  it('honors an explicit feeRateSatsPerVByte', async () => {
    const { chain } = makeChainWithUtxo(200_000);
    const unsigned = await chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 30_000n,
      feeRateSatsPerVByte: 25,
    });
    expect(unsigned.feeRateSatsPerVByte).toBe(25);
    expect(unsigned.feeSats).toBeGreaterThan(0);
  });

  it('adds an OP_RETURN memo output when memo is provided', async () => {
    const { chain } = makeChainWithUtxo(200_000);
    const unsigned = await chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 50_000n,
      memo: 'hello',
    });
    const psbt = Psbt.fromBase64(unsigned.psbtBase64, { network: networks.testnet });
    const opReturnOutputs = psbt.txOutputs.filter((o) => o.script[0] === 0x6a);
    expect(opReturnOutputs).toHaveLength(1);
  });

  it('rejects a transfer that would burn the recipient below dust', async () => {
    const { chain } = makeChainWithUtxo(200_000);
    await expect(
      chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        amount: 100n,
      })
    ).rejects.toThrow(/dust/);
  });

  it('throws when the sender has no UTXOs', async () => {
    const tool = new FakeBtcTool();
    const chain = chainFromTool(tool);
    await expect(
      chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        amount: 50_000n,
      })
    ).rejects.toThrow(/no spendable UTXOs/);
  });

  it('rejects non-native token identifiers', async () => {
    const { chain } = makeChainWithUtxo(200_000);
    await expect(
      chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_TESTNET_P2WPKH,
        tokenIdentifier: '0xfaketoken',
        amount: 50_000n,
      })
    ).rejects.toThrow();
  });

  it('builds a tx whose total output + fee equals total input', async () => {
    const { chain } = makeChainWithUtxo(500_000);
    const unsigned = await chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 100_000n,
    });
    expect(unsigned.totalInputSats).toBe(unsigned.totalOutputSats + unsigned.feeSats);
  });

  it('marks the input in inputsToSign under the owner address', async () => {
    const { chain } = makeChainWithUtxo(200_000);
    const unsigned = await chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 50_000n,
    });
    expect(unsigned.inputsToSign[SENDER_TESTNET_P2WPKH]).toEqual([0]);
  });

  it('honors rbfEnabled: false (sequence = FINAL)', async () => {
    const { chain } = makeChainWithUtxo(200_000);
    const unsigned = await chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      amount: 50_000n,
      rbfEnabled: false,
    });
    const psbt = Psbt.fromBase64(unsigned.psbtBase64, { network: networks.testnet });
    expect(psbt.txInputs[0].sequence).toBe(0xffffffff);
  });
});

describe('BtcChain.createTransferUnsignedTransaction — multi-output', () => {
  const RECIPIENT_A = 'tb1q9h0yjdupyfpxfjg24rpx755xrplvzd9hz2nj7v';
  const RECIPIENT_B = 'tb1q8dv27vfa8gyc3ugucpezcrqr9972dn4z04p8ec';
  const RECIPIENT_C = 'tb1qaufzsq0npgkclme37zvt3gea9wwvhe9nt3v8c9';

  it('accepts an outputs[] array and lays them down in order followed by change', async () => {
    const { chain } = makeChainWithUtxo(500_000);
    const unsigned = await chain.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      outputs: [
        { to: RECIPIENT_A, amount: 30_000n },
        { to: RECIPIENT_B, amount: 10_000n },
        { to: RECIPIENT_C, amount: 5_000n },
      ],
    } as any);
    const psbt = Psbt.fromBase64(unsigned.psbtBase64, { network: networks.testnet });
    // 3 recipient outputs + 1 change output = at least 4
    expect(psbt.txOutputs.length).toBeGreaterThanOrEqual(4);
    expect(psbt.txOutputs[0].value).toBe(30_000n);
    expect(psbt.txOutputs[1].value).toBe(10_000n);
    expect(psbt.txOutputs[2].value).toBe(5_000n);
    // Change goes last (before optional OP_RETURN)
    expect(psbt.txOutputs[3].address).toBe(SENDER_TESTNET_P2WPKH);
    expect(unsigned.totalOutputSats).toBe(45_000 + (500_000 - 45_000 - unsigned.feeSats));
  });

  it('rejects a multi-output list where any amount is below dust', async () => {
    const { chain } = makeChainWithUtxo(500_000);
    await expect(
      chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        outputs: [
          { to: RECIPIENT_A, amount: 30_000n },
          { to: RECIPIENT_B, amount: 100n }, // below dust
        ],
      } as any),
    ).rejects.toThrow(/below dust/);
  });

  it('rejects a multi-output list where any address is invalid', async () => {
    const { chain } = makeChainWithUtxo(500_000);
    await expect(
      chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
        outputs: [
          { to: RECIPIENT_A, amount: 30_000n },
          { to: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', amount: 10_000n }, // mainnet
        ],
      } as any),
    ).rejects.toThrow(/invalid recipient address at outputs\[1\]/);
  });

  it('rejects both single-output and outputs[] set together', async () => {
    const { chain } = makeChainWithUtxo(500_000);
    await expect(
      chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        to: RECIPIENT_A,
        amount: 30_000n,
        tokenIdentifier: undefined,
        outputs: [{ to: RECIPIENT_B, amount: 10_000n }],
      } as any),
    ).rejects.toThrow(/cannot specify both single-output.*and multi-output/);
  });

  it('rejects when neither single-output nor outputs[] is set', async () => {
    const { chain } = makeChainWithUtxo(500_000);
    await expect(
      chain.createTransferUnsignedTransaction({
        from: SENDER_TESTNET_P2WPKH,
        tokenIdentifier: undefined,
      } as any),
    ).rejects.toThrow(/must specify either.*or a non-empty outputs/);
  });

  it('fee scales with the number of outputs (three outputs > one output)', async () => {
    const { chain: chainA } = makeChainWithUtxo(500_000);
    const oneOutput = await chainA.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      to: RECIPIENT_A,
      tokenIdentifier: undefined,
      amount: 45_000n,
    });
    const { chain: chainB } = makeChainWithUtxo(500_000);
    const threeOutputs = await chainB.createTransferUnsignedTransaction({
      from: SENDER_TESTNET_P2WPKH,
      tokenIdentifier: undefined,
      outputs: [
        { to: RECIPIENT_A, amount: 30_000n },
        { to: RECIPIENT_B, amount: 10_000n },
        { to: RECIPIENT_C, amount: 5_000n },
      ],
    } as any);
    // Two extra outputs add ~62 vbytes at P2WPKH; fee scales linearly.
    expect(threeOutputs.feeSats).toBeGreaterThan(oneOutput.feeSats);
    expect(threeOutputs.estimatedVBytes).toBeGreaterThan(oneOutput.estimatedVBytes);
  });
});

describe('BtcChain.getBalance', () => {
  it('returns the confirmed balance for the address', async () => {
    const { chain } = makeChainWithUtxo(123_456);
    const balance = await chain.getBalance(SENDER_TESTNET_P2WPKH, undefined);
    expect(balance).toBe(123_456n);
  });
});

describe('BtcChain network params', () => {
  it('exposes the right network params on the chain', () => {
    const chain = chainFromTool(new FakeBtcTool());
    expect(chain.params).toBe(BITCOIN_TESTNET_PARAMS);
  });
});
