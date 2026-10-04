import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Account,
  AccountRequiresMemoError,
  Address,
  BadResponseError,
  Keypair,
  Memo,
  Networks,
  NotFoundError,
  SorobanDataBuilder,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToBigInt,
  xdr,
} from '@stellar/stellar-sdk';
import { Decimal } from 'decimal.js';

import { addressFor } from '../../address.factory.ts';
import { CHAIN_ID_STELLAR_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { NetworkType, networkTypeOf } from '../../network_type.ts';
import { FeePriority } from '../../priority.ts';
import { TronGasPricing } from '../../tron/tron_gas_pricing.ts';
import { StellarAsset } from '../stellar_asset.ts';
import { STELLAR_BNUSD, STELLAR_USDC } from '../stellar_assets.ts';
import { StellarChain, StellarSignedMessage } from '../stellar_chain.ts';
import { StellarGasPricing } from '../stellar_gas_pricing.ts';
import {
  StellarChangeTrustLineTransactionPrerequisite,
  StellarSignedTransaction,
  StellarUnsignedTransaction,
} from '../stellar_transactions.ts';
import { StellarWallet } from '../stellar_wallet.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SENDER = StellarWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/148'/0'" });
const RECEIVER = StellarWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/148'/1'" });
const CONTRACT = 'CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const recordings = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mainnet_status_recordings.json'), 'utf8'),
) as { expert: Record<string, { meta: string }> };

interface Fakes {
  baseFee: number;
  accounts: Record<string, Record<string, unknown>>;
  submitted: Transaction[];
  submitError: Error | null;
  submitReply: unknown;
  prepared: Transaction[];
  simulation: Record<string, unknown> | null;
  prepareSimulation: Record<string, unknown>;
  strictSendRecords: Record<string, unknown>[];
}

function fakeChain(overrides: Partial<Fakes> = {}): { chain: StellarChain; fakes: Fakes } {
  const fakes: Fakes = {
    baseFee: 100,
    accounts: {},
    submitted: [],
    submitError: null,
    submitReply: null,
    prepared: [],
    simulation: null,
    prepareSimulation: {
      id: '1',
      latestLedger: 1,
      transactionData: new SorobanDataBuilder().build().toXDR('base64'),
      minResourceFee: '0',
      results: [{ auth: [], xdr: xdr.ScVal.scvVoid().toXDR('base64') }],
    },
    strictSendRecords: [],
    ...overrides,
  };
  const chain = new StellarChain({
    name: 'Stellar Fake',
    defaultHorizonUrl: 'https://horizon.invalid',
    defaultSorobanRpcUrl: 'https://soroban.invalid',
    explorerUrl: 'https://stellar.expert/explorer/public',
    stellarExpertApiUrl: 'https://api.stellar.expert/explorer/public',
    networkPassphrase: Networks.PUBLIC,
    chainId: CHAIN_ID_STELLAR_MAINNET,
    chainAgnosticStellarIdentifier: 'pubnet',
  });
  const horizon = {
    loadAccount: async (id: string) => new Account(id, String(fakes.accounts[id]?.sequence ?? '100')),
    accounts: () => ({ accountId: (id: string) => ({ call: async () => fakes.accounts[id] }) }),
    strictSendPaths: () => ({ call: async () => ({ records: fakes.strictSendRecords }) }),
    ledgers: () => ({
      order: () => ({ limit: () => ({ call: async () => ({ records: [{ sequence: 64747332, base_fee_in_stroops: fakes.baseFee }] }) }) }),
    }),
  };
  const soroban = {};
  Object.defineProperty(chain, 'asyncHorizonServer', { get: () => horizon });
  Object.defineProperty(chain, 'asyncSorobanServer', { get: () => soroban });
  chain._sorobanRpc = async (_method: string, params: Record<string, unknown>) => {
    const tx = TransactionBuilder.fromXDR(params.transaction as string, Networks.PUBLIC) as Transaction;
    const prepared = tx.toEnvelope().v1().tx().ext().switch() === 1;
    if (prepared && fakes.simulation !== null) return fakes.simulation;
    fakes.prepared.push(tx);
    return fakes.prepareSimulation;
  };
  chain._submitTransaction = async (tx: Transaction) => {
    if (fakes.submitError) throw fakes.submitError;
    fakes.submitted.push(tx);
    return fakes.submitReply ?? { hash: tx.hash().toString('hex') };
  };
  return { chain, fakes };
}

function sac(chain: StellarChain): StellarAsset {
  return chain.createSacToken('USDC', USDC_ISSUER);
}

describe('StellarChain.createTransferTransaction', () => {
  it('native XLM to an account: classic Payment, network base fee, no prerequisite', async () => {
    const { chain } = fakeChain();
    const bundle = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('0.001'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER.address,
    });
    expect(bundle.prerequisites).toEqual([]);
    const tx = bundle.transaction;
    expect(tx.baseFee).toBe(100);
    expect(tx.memo).toBeNull();
    expect(tx.isSorobanInvokeContractTransaction).toBe(false);
    const op = Operation.fromXDRObject(tx.operations[0]) as Operation.Payment;
    expect(op).toMatchObject({ type: 'payment', destination: RECEIVER.address, amount: '0.0010000', source: SENDER.address });
    expect(op.asset.isNative()).toBe(true);
  });

  it('SAC asset to an account adds a max-limit trustline prerequisite for the receiver', async () => {
    const { chain } = fakeChain();
    const bundle = await chain.createTransferTransaction({
      asset: sac(chain),
      amountHr: new Decimal('5'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER.address,
      memoText: 'invoice-7',
    });
    expect(bundle.transaction.memo?.value?.toString()).toBe('invoice-7');
    expect(bundle.prerequisites).toHaveLength(1);
    const prerequisite = bundle.prerequisites[0] as StellarChangeTrustLineTransactionPrerequisite;
    expect(prerequisite).toBeInstanceOf(StellarChangeTrustLineTransactionPrerequisite);
    expect(prerequisite).toMatchObject({ code: 'USDC', issuer: USDC_ISSUER, walletAddress: RECEIVER.address });
    expect(prerequisite.limit.toString()).toBe('922337203685.4775807');
  });

  it('SAC to a contract becomes a Soroban transfer(from, to, i128) and needs no trustline', async () => {
    const { chain } = fakeChain();
    const bundle = await chain.createTransferTransaction({
      asset: sac(chain),
      amountHr: new Decimal('1.25'),
      senderAddress: SENDER.address,
      receiverAddress: CONTRACT,
    });
    expect(bundle.prerequisites).toEqual([]);
    expect(bundle.transaction.isSorobanInvokeContractTransaction).toBe(true);
    const invoke = bundle.transaction.operations[0].body().invokeHostFunctionOp().hostFunction().invokeContract();
    expect(Address.fromScAddress(invoke.contractAddress()).toString()).toBe(STELLAR_USDC.contractId);
    expect(invoke.functionName().toString()).toBe('transfer');
    const [from, to, amount] = invoke.args();
    expect(Address.fromScVal(from).toString()).toBe(SENDER.address);
    expect(Address.fromScVal(to).toString()).toBe(CONTRACT);
    expect(scValToBigInt(amount)).toBe(12_500_000n);
    await expect(
      chain.createTransferTransaction({ asset: sac(chain), amountHr: new Decimal('1'), senderAddress: SENDER.address, receiverAddress: CONTRACT, memoText: 'm' }),
    ).rejects.toThrow(/do not support memos/);
  });

  it('non-SAC token always uses the Soroban transfer; muxed receivers are reduced to the classic account', async () => {
    const { chain } = fakeChain();
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(RECEIVER.address), Buffer.alloc(8, 1)]));
    const bnusd = new StellarAsset({ chainId: chain.chainId, networkPassphrase: Networks.PUBLIC, code: 'BnUSD', issuer: null, contractId: STELLAR_BNUSD.contractId, decimals: 18 });
    const tokenTx = await chain.createTransferTransaction({ asset: bnusd, amountHr: new Decimal('0.000012'), senderAddress: SENDER.address, receiverAddress: muxed });
    const args = tokenTx.transaction.operations[0].body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    expect(Address.fromScVal(args[1]).toString()).toBe(RECEIVER.address);
    expect(scValToBigInt(args[2])).toBe(12_000_000_000_000n);
    expect(tokenTx.prerequisites).toEqual([]);
    const classic = await chain.createTransferTransaction({ asset: chain.nativeAsset, amountHr: new Decimal('1'), senderAddress: SENDER.address, receiverAddress: muxed });
    expect((Operation.fromXDRObject(classic.transaction.operations[0]) as Operation.Payment).destination).toBe(RECEIVER.address);
  });

  it('fee priority multipliers, the 100-stroop floor and explicit StellarGasPricing', async () => {
    const make = async (gasPricing: Parameters<StellarChain['createTransferTransaction']>[0]['gasPricing'], baseFee = 100) => {
      const { chain } = fakeChain({ baseFee });
      return (
        await chain.createTransferTransaction({ asset: chain.nativeAsset, amountHr: new Decimal(1), senderAddress: SENDER.address, receiverAddress: RECEIVER.address, gasPricing })
      ).transaction.baseFee;
    };
    expect(await make(FeePriority.SLOW, 250)).toBe(250);
    expect(await make(FeePriority.FAST, 250)).toBe(500);
    expect(await make(FeePriority.NORMAL, 40)).toBe(100);
    expect(await make(new StellarGasPricing({ baseFeeStroops: 30 }))).toBe(100);
    expect(await make(new StellarGasPricing({ baseFeeStroops: 1500 }))).toBe(1500);
    await expect(make(new TronGasPricing({ feeLimitSun: 1 }))).rejects.toThrow(/Expected StellarGasPricing/);
  });

  it('rejects invalid sender/receiver and foreign-chain assets', async () => {
    const { chain } = fakeChain();
    await expect(
      chain.createTransferTransaction({ asset: chain.nativeAsset, amountHr: new Decimal(1), senderAddress: 'nope', receiverAddress: RECEIVER.address }),
    ).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidAddress });
    await expect(
      chain.createTransferTransaction({ asset: chain.nativeAsset, amountHr: new Decimal(1), senderAddress: SENDER.address, receiverAddress: 'nope' }),
    ).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidAddress });
    const testnetXlm = new StellarAsset({ chainId: -3501, networkPassphrase: Networks.TESTNET, code: 'XLM', issuer: null });
    await expect(
      chain.createTransferTransaction({ asset: testnetXlm, amountHr: new Decimal(1), senderAddress: SENDER.address, receiverAddress: RECEIVER.address }),
    ).rejects.toThrow(/Invalid chain id/);
  });
});

describe('StellarUnsignedTransaction.buildTransactionEnvelope', () => {
  it('loads the sequence, applies the base fee, memo and a 300s time bound', async () => {
    const { chain } = fakeChain({ accounts: { [SENDER.address]: { sequence: '41' } } });
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('2'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER.address,
      memoText: 'abc',
    });
    const envelope = await transaction.buildTransactionEnvelope(chain);
    expect(envelope.sequence).toBe('42');
    expect(envelope.fee).toBe('100');
    expect(envelope.memo.type).toBe('text');
    const max = Number(envelope.timeBounds?.maxTime);
    expect(Math.abs(max - (Math.floor(Date.now() / 1000) + 300))).toBeLessThanOrEqual(2);
  });

  it('falls back to the network base fee when none was given and prepares Soroban transactions', async () => {
    const { chain, fakes } = fakeChain({ baseFee: 321 });
    const unsigned = chain.buildUnsignedTransaction({
      sourceAddress: SENDER.address,
      operations: [chain.buildTokenTransferOperation({ asset: sac(chain), senderAddress: SENDER.address, receiverAddress: CONTRACT, amountHr: new Decimal(1) })],
    });
    const envelope = await unsigned.buildTransactionEnvelope(chain);
    expect(envelope.fee).toBe('321');
    expect(fakes.prepared).toHaveLength(1);
  });

  it('a Soroban transport failure becomes a ChainError carrying its message', async () => {
    const { chain } = fakeChain();
    chain._sorobanRpc = async () => Promise.reject(new Error('socket hang up'));
    const expected = { kind: ChainErrorKinds.RpcError, message: 'socket hang up' };
    await expect(chain.resolveAsset(STELLAR_BNUSD.contractId)).rejects.toMatchObject(expected);
    const unsigned = chain.buildUnsignedTransaction({
      sourceAddress: SENDER.address,
      operations: [chain.buildTokenTransferOperation({ asset: sac(chain), senderAddress: SENDER.address, receiverAddress: CONTRACT, amountHr: new Decimal(1) })],
    });
    await expect(unsigned.buildTransactionEnvelope(chain)).rejects.toMatchObject(expected);
  });


  it('enforces Soroban rules: single InvokeHostFunction and no memo; rejects another chain', async () => {
    const { chain } = fakeChain();
    const invoke = chain.buildTokenTransferOperation({ asset: sac(chain), senderAddress: SENDER.address, receiverAddress: CONTRACT, amountHr: new Decimal(1) });
    const twoOps = new StellarUnsignedTransaction({ chainId: chain.chainId, sourceAccountId: SENDER.address, operations: [invoke, invoke] });
    await expect(twoOps.buildTransactionEnvelope(chain)).rejects.toThrow(/exactly 1 operation/);
    const withMemo = new StellarUnsignedTransaction({ chainId: chain.chainId, sourceAccountId: SENDER.address, operations: [invoke], memo: Memo.text('x') });
    await expect(withMemo.buildTransactionEnvelope(chain)).rejects.toThrow(
      "Soroban Transactions (Operation InvokeHostFunction) does not support memo, received <TextMemo [memo=b'x']>",
    );
    const noneMemo = new StellarUnsignedTransaction({ chainId: chain.chainId, sourceAccountId: SENDER.address, operations: [invoke], memo: Memo.none() });
    await expect(noneMemo.buildTransactionEnvelope(chain)).resolves.toBeInstanceOf(Transaction);
    const other = new StellarUnsignedTransaction({ chainId: -3501, sourceAccountId: SENDER.address, operations: [invoke] });
    await expect(other.buildTransactionEnvelope(chain)).rejects.toThrow(/cannot be built/);
  });

  it('fromXdr recovers the classic source, operations and memo from an envelope', async () => {
    const { chain } = fakeChain();
    const built = new TransactionBuilder(new Account(SENDER.address, '9'), { fee: '100', networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.payment({ destination: RECEIVER.address, asset: STELLAR_USDC.toSdkAsset(), amount: '3' }))
      .addMemo(Memo.text('round'))
      .setTimeout(0)
      .build();
    const unsigned = StellarUnsignedTransaction.fromXdr(chain, built.toXDR());
    expect(unsigned.sourceAccountId).toBe(SENDER.address);
    expect(unsigned.operations[0].toXDR('base64')).toBe(built.toEnvelope().v1().tx().operations()[0].toXDR('base64'));
    expect(unsigned.memo?.value?.toString()).toBe('round');
    expect(unsigned.baseFee).toBeNull();
  });
});

describe('StellarChain.simulateTransaction', () => {
  it('classic: predicts deltas from the operations and adds the fee debit', async () => {
    const { chain } = fakeChain();
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('0.001'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER.address,
      memoText: 'sim',
    });
    const sim = await chain.simulateTransaction({ transaction, senderWalletAddress: SENDER.address });
    expect(sim.statusType).toBe('Success');
    const native = chain.nativeAsset.identifier;
    const get = (w: string) => [...(sim.balanceChanges.get(w)?.values() ?? [])].find((e) => e.token.identifier === native)?.change.balanceChangeHr.toString();
    expect(get(RECEIVER.address)).toBe('0.001');
    expect(get(SENDER.address)).toBe('-0.00101');
    expect(sim.fees).toMatchObject({ feeStroops: 100, feePayer: SENDER.address });
    expect(sim.memo?.value?.toString()).toBe('sim');
    expect(await chain.supportsFullTransactionSimulation(transaction)).toBe(true);
  });

  it('path payments: strict-send credits destMin, strict-receive debits sendMax; asset filters apply', () => {
    const { chain } = fakeChain();
    const usdc = sac(chain);
    const tx = new TransactionBuilder(new Account(SENDER.address, '1'), { fee: '100', networkPassphrase: Networks.PUBLIC })
      .addOperation(
        Operation.pathPaymentStrictSend({ sendAsset: usdc.toSdkAsset(), sendAmount: '3.2848120', destination: RECEIVER.address, destAsset: chain.nativeAsset.toSdkAsset(), destMin: '19.9' }),
      )
      .addOperation(
        Operation.pathPaymentStrictReceive({ sendAsset: chain.nativeAsset.toSdkAsset(), sendMax: '5', destination: RECEIVER.address, destAsset: usdc.toSdkAsset(), destAmount: '1' }),
      )
      .addOperation(Operation.changeTrust({ asset: usdc.toSdkAsset() }))
      .setTimeout(0)
      .build();
    const all = chain._balanceChangesFromOperations(tx);
    const hr = (m: typeof all, w: string, id: string | undefined) =>
      [...(m.get(w)?.values() ?? [])].find((e) => e.token.identifier === id)?.change.balanceChangeHr.toString();
    expect(hr(all, SENDER.address, usdc.identifier)).toBe('-3.284812');
    expect(hr(all, SENDER.address, chain.nativeAsset.identifier)).toBe('-5');
    expect(hr(all, RECEIVER.address, chain.nativeAsset.identifier)).toBe('19.9');
    expect(hr(all, RECEIVER.address, usdc.identifier)).toBe('1');
    const onlyUsdc = chain._balanceChangesFromOperations(tx, { filteredAssets: [usdc] });
    expect(hr(onlyUsdc, RECEIVER.address, chain.nativeAsset.identifier)).toBeUndefined();
    const onlyReceiver = chain._balanceChangesFromOperations(tx, { filteredWallets: new Set([RECEIVER.address]) });
    expect(onlyReceiver.has(SENDER.address)).toBe(false);
  });

  it('Soroban: decodes the simulated diagnostic events and reports the min resource fee as fees', async () => {
    const meta = xdr.TransactionMeta.fromXDR(Object.values(recordings.expert)[0].meta, 'base64');
    const events = meta.v4().diagnosticEvents();
    const { chain } = fakeChain({ simulation: { latestLedger: 1, events: events.map((e) => e.toXDR('base64')), minResourceFee: '4321' } });
    chain._callHostFunction = async (req) =>
      [{ xdr: (req.functionName === 'decimals' ? nativeToScVal(18, { type: 'u32' }) : nativeToScVal('BnUSD', { type: 'string' })).toXDR('base64') }];
    const unsigned = chain.buildUnsignedTransaction({
      sourceAddress: SENDER.address,
      operations: [chain.buildTokenTransferOperation({ asset: sac(chain), senderAddress: SENDER.address, receiverAddress: CONTRACT, amountHr: new Decimal(1) })],
    });
    const sim = await chain.simulateTransaction({ transaction: unsigned, senderWalletAddress: SENDER.address });
    expect(sim.statusType).toBe('Success');
    expect(sim.fees).toMatchObject({ feeStroops: 4321, feePayer: SENDER.address });
    expect(sim.balanceChanges.size).toBeGreaterThan(0);
  });

  it('Soroban simulation errors become a Failed result', async () => {
    const { chain } = fakeChain({ simulation: { latestLedger: 1, events: [], error: 'HostError: trapped' } });
    const unsigned = chain.buildUnsignedTransaction({
      sourceAddress: SENDER.address,
      operations: [chain.buildTokenTransferOperation({ asset: sac(chain), senderAddress: SENDER.address, receiverAddress: CONTRACT, amountHr: new Decimal(1) })],
    });
    const sim = await chain.simulateTransaction({ transaction: unsigned, senderWalletAddress: SENDER.address });
    expect(sim.statusType).toBe('Failed');
    expect(sim.error?.message).toBe('HostError: trapped');
  });
});

describe('StellarChain balances and trustlines', () => {
  const account = (balances: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ balances, subentry_count: 3, num_sponsoring: 1, num_sponsored: 2, ...extra });

  it('native balance subtracts (2 + subentries + sponsoring - sponsored) * 0.5 XLM and never goes negative', async () => {
    const { chain } = fakeChain({ accounts: { [SENDER.address]: account([{ asset_type: 'native', balance: '10.5000000' }]) } });
    expect((await chain.getAssetBalance(chain.nativeAsset, SENDER.address)).toString()).toBe('8.5');
    const poor = fakeChain({ accounts: { [SENDER.address]: account([{ asset_type: 'native', balance: '1.0000000' }]) } });
    expect((await poor.chain.getAssetBalance(poor.chain.nativeAsset, SENDER.address)).toString()).toBe('0');
    expect(await chain.getBalance(SENDER.address)).toBe(85_000_000n);
  });

  it('SAC balance comes from the trustline; missing trustline is 0; wallet balance lists every line', async () => {
    const { chain } = fakeChain({
      accounts: {
        [SENDER.address]: account([
          { asset_type: 'native', balance: '10.0000000' },
          { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '12.3456789', limit: '1000.0000000' },
          { asset_type: 'liquidity_pool_shares', balance: '1.0000000' },
        ]),
        [RECEIVER.address]: account([{ asset_type: 'native', balance: '5.0000000' }]),
      },
    });
    expect((await chain.getAssetBalance(sac(chain), SENDER.address)).toString()).toBe('12.3456789');
    expect((await chain.getAssetBalance(sac(chain), RECEIVER.address)).toString()).toBe('0');
    const wallet = await chain.getWalletBalance(SENDER.address);
    expect([...wallet.entries()].map(([a, v]) => [a.symbol, v.toString()])).toEqual([
      ['XLM', '10'],
      ['USDC', '12.3456789'],
    ]);
    const line = await chain.getTrustLineLimit(SENDER.address, sac(chain));
    expect([line.balance.toString(), line.limit.toString()]).toEqual(['12.3456789', '1000']);
    const none = await chain.getTrustLineLimit(RECEIVER.address, sac(chain));
    expect([none.balance.toString(), none.limit.toString()]).toEqual(['0', '0']);
    await expect(chain.getTrustLineLimit(SENDER.address, chain.nativeAsset)).rejects.toThrow(/native XLM/);
  });

  it('non-SAC balance is exact (no float rounding on 18 decimals)', async () => {
    const { chain } = fakeChain();
    chain._callHostFunction = async () => [{ xdr: nativeToScVal(123_456_789_012_345_678_901n, { type: 'i128' }).toXDR('base64') }];
    const bnusd = new StellarAsset({ chainId: chain.chainId, networkPassphrase: Networks.PUBLIC, code: 'BnUSD', issuer: null, contractId: STELLAR_BNUSD.contractId, decimals: 18 });
    expect((await chain.getAssetBalance(bnusd, SENDER.address)).toString()).toBe('123.456789012345678901');
  });

  it('createPrerequisiteForReceivableAsset only for SAC assets', () => {
    const { chain } = fakeChain();
    expect(chain.createPrerequisiteForReceivableAsset(chain.nativeAsset, RECEIVER.address)).toBeNull();
    const bnusd = new StellarAsset({ chainId: chain.chainId, networkPassphrase: Networks.PUBLIC, code: 'BnUSD', issuer: null, contractId: STELLAR_BNUSD.contractId, decimals: 18 });
    expect(chain.createPrerequisiteForReceivableAsset(bnusd, RECEIVER.address)).toBeNull();
    expect(chain.createPrerequisiteForReceivableAsset(sac(chain), RECEIVER.address)?.walletAddress).toBe(RECEIVER.address);
    expect(() => chain.createPrerequisiteForReceivableAsset(sac(chain), CONTRACT)).toThrow(/Invalid Stellar wallet address/);
  });

  it('resolveAsset distinguishes native, SAC ("CODE:ISSUER") and non-SAC tokens', async () => {
    const { chain } = fakeChain();
    const replies: Record<string, xdr.ScVal> = {
      decimals: nativeToScVal(7, { type: 'u32' }),
      name: nativeToScVal(`USDC:${USDC_ISSUER}`, { type: 'string' }),
    };
    chain._callHostFunction = async (req) => [{ xdr: replies[req.functionName].toXDR('base64') }];
    const resolved = await chain.resolveAsset(STELLAR_USDC.contractId);
    expect(resolved).toMatchObject({ code: 'USDC', issuer: USDC_ISSUER, contractId: STELLAR_USDC.contractId, decimals: 7 });
    replies.name = nativeToScVal('native', { type: 'string' });
    expect(await chain.resolveAsset(CONTRACT)).toBe(chain.nativeAsset);
    replies.name = nativeToScVal('Bridged USD', { type: 'string' });
    replies.decimals = nativeToScVal(18, { type: 'u32' });
    replies.symbol = nativeToScVal('BnUSD', { type: 'string' });
    expect(await chain.resolveAsset(STELLAR_BNUSD.contractId)).toMatchObject({ code: 'BnUSD', issuer: null, decimals: 18 });
    expect(await chain.resolveAsset(undefined)).toBe(chain.nativeAsset);
    expect(() => chain.createAsset('X', null, 7)).toThrow(/create_asset/);
  });
});

describe('StellarChain.createExactInSwapTransaction', () => {
  it('uses the best strict-send path and rounds dest_min half-up to the receive asset decimals', async () => {
    const { chain } = fakeChain({
      strictSendRecords: [
        { destination_amount: '19.9818755', path: [{ asset_type: 'credit_alphanum4', asset_code: 'EURC', asset_issuer: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2' }] },
        { destination_amount: '1', path: [] },
      ],
    });
    const bundle = await chain.createExactInSwapTransaction({
      sendAsset: chain.nativeAsset,
      receiveAsset: sac(chain),
      sendAmount: new Decimal('3.2848120'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER.address,
      slippageTolerancePercent: new Decimal('0.5'),
    });
    const op = Operation.fromXDRObject(bundle.transaction.operations[0]) as Operation.PathPaymentStrictSend;
    expect(op.type).toBe('pathPaymentStrictSend');
    expect(op.destMin).toBe('19.8819661');
    expect(op.sendAmount).toBe('3.2848120');
    expect(op.path.map((a) => a.getCode())).toEqual(['EURC']);
    expect(bundle.transaction.baseFee).toBeNull();
    expect(bundle.prerequisites).toHaveLength(1);
  });

  it('fails when no route exists', async () => {
    const { chain } = fakeChain();
    await expect(
      chain.createExactInSwapTransaction({
        sendAsset: chain.nativeAsset,
        receiveAsset: sac(chain),
        sendAmount: new Decimal('1'),
        senderAddress: SENDER.address,
        receiverAddress: RECEIVER.address,
        slippageTolerancePercent: new Decimal(1),
      }),
    ).rejects.toThrow('Cannot find a swap route');
  });
});

describe('Signing, broadcasting and trustline handling', () => {
  it('wallet signs the envelope; broadcastSignedTransaction keeps the hash on failure', async () => {
    const { chain, fakes } = fakeChain();
    const { transaction } = await chain.createTransferTransaction({ asset: chain.nativeAsset, amountHr: new Decimal(1), senderAddress: SENDER.address, receiverAddress: RECEIVER.address });
    const signed = await SENDER.signTransaction(transaction, chain);
    expect(signed).toBeInstanceOf(StellarSignedTransaction);
    const envelope = TransactionBuilder.fromXDR(signed.signedXdr, Networks.PUBLIC) as Transaction;
    expect(Keypair.fromPublicKey(SENDER.address).verify(envelope.hash(), envelope.signatures[0].signature())).toBe(true);

    const ok = await chain.broadcastSignedTransaction(signed);
    expect(ok.txHash).toBe(signed.txHash);
    expect(fakes.submitted).toHaveLength(1);

    fakes.submitError = new BadResponseError('Transaction submission failed. Server responded: 400 Bad Request', {
      status: 400,
      extras: { result_codes: { transaction: 'tx_bad_seq' } },
    });
    const failed = await chain.broadcastSignedTransaction(signed);
    expect(failed.txHash).toBe(signed.txHash);
    expect(failed.isBroadcastConfirmed).toBe(false);
    await expect(chain.broadcast(signed.signedXdr)).rejects.toMatchObject({
      kind: ChainErrorKinds.BroadcastRejected,
      message: expect.stringContaining('{"transaction":"tx_bad_seq"}'),
    });
    fakes.submitError = new AccountRequiresMemoError('account requires memo', RECEIVER.address, 0);
    expect((await chain.broadcastSignedTransaction(signed)).broadcastError).toBe(fakes.submitError);
    await expect(chain.broadcast(signed.signedXdr)).rejects.toMatchObject({
      kind: ChainErrorKinds.BroadcastRejected,
      message: expect.stringContaining('requires a memo (SEP-29'),
    });
    fakes.submitError = new Error('socket hang up');
    await expect(chain.broadcast(signed.toJsonStr())).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError });
    fakes.submitError = null;
    expect(await chain.broadcast(Buffer.from(signed.signedXdr, 'base64'))).toBe(signed.txHash);

    for (const hash of [null, 5, '', 'ab'.repeat(32)]) {
      fakes.submitReply = { hash };
      expect((await chain.broadcastSignedTransaction(signed)).txHash).toBe(hash);
      await expect(chain.broadcast(signed.signedXdr)).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError, meta: { txHash: signed.txHash } });
    }
    fakes.submitReply = { hash: signed.txHash };
    expect(await chain.broadcast(signed.signedXdr)).toBe(signed.txHash);

    for (const reply of [{}, '<html>maintenance</html>']) {
      fakes.submitReply = reply;
      const noHash = await chain.broadcastSignedTransaction(signed);
      expect(noHash.txHash).toBe(signed.txHash);
      expect(noHash.broadcastError?.message).toBe("'hash'");
      expect(noHash.broadcastError).toMatchObject({ kind: ChainErrorKinds.RpcError });
      await expect(chain.broadcast(signed.signedXdr)).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError, meta: { txHash: signed.txHash } });
    }
  });

  it('ensureMinimumTrustLine skips when the limit is high enough and submits ChangeTrust otherwise', async () => {
    const high = fakeChain({
      accounts: { [RECEIVER.address]: { balances: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '0', limit: '922337203685.4775807' }] } },
    });
    const prerequisite = high.chain.createPrerequisiteForReceivableAsset(sac(high.chain), RECEIVER.address) as StellarChangeTrustLineTransactionPrerequisite;
    expect((await RECEIVER.handleTransactionPrerequisite(prerequisite, high.chain)).skipped).toBe(true);
    expect(high.fakes.submitted).toHaveLength(0);

    const low = fakeChain({ accounts: { [RECEIVER.address]: { balances: [] } } });
    const response = await RECEIVER.handleTransactionPrerequisite(prerequisite, low.chain);
    expect(response.skipped).toBe(false);
    expect(low.fakes.submitted).toHaveLength(1);
    const op = low.fakes.submitted[0].operations[0] as Operation.ChangeTrust;
    expect(op.type).toBe('changeTrust');
    expect(op.limit).toBe('922337203685.4775807');
    expect(response.txHash).toBe(low.fakes.submitted[0].hash().toString('hex'));
  });

  it('a prerequisite for another wallet is never handled (Python raises in both branches)', async () => {
    const enough = fakeChain({
      accounts: { [RECEIVER.address]: { balances: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '0', limit: '922337203685.4775807' }] } },
    });
    const prerequisite = enough.chain.createPrerequisiteForReceivableAsset(sac(enough.chain), RECEIVER.address) as StellarChangeTrustLineTransactionPrerequisite;
    await expect(SENDER.handleTransactionPrerequisite(prerequisite, enough.chain)).rejects.toThrow(/cannot handle trustline prerequisite/);
    const missing = fakeChain({ accounts: { [RECEIVER.address]: { balances: [] } } });
    await expect(SENDER.handleTransactionPrerequisite(prerequisite, missing.chain)).rejects.toThrow(/Prerequisite not handled/);
  });

  it('closeTrustLine refuses while the line still holds a balance', async () => {
    const { chain } = fakeChain({
      accounts: { [SENDER.address]: { balances: [{ asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '1.0000000', limit: '5' }] } },
    });
    await expect(SENDER.closeTrustLine(chain, 'USDC', USDC_ISSUER)).rejects.toThrow(/Removing trustline requires zero balance/);
  });
});

describe('Stellar chain metadata and adapters', () => {
  it('validation, classic account extraction, explorer URLs and chain tip', async () => {
    const { chain } = fakeChain({ accounts: { [SENDER.address]: { sequence: '99' } } });
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.concat([StrKey.decodeEd25519PublicKey(SENDER.address), Buffer.alloc(8, 9)]));
    expect(chain.validateAddress(SENDER.address)).toBe(true);
    expect(chain.validateAddress(muxed)).toBe(true);
    expect(chain.validateAddress(CONTRACT)).toBe(false);
    expect(chain.validateTokenIdentifier(CONTRACT)).toBe(true);
    expect(chain.validateTokenIdentifier(SENDER.address)).toBe(false);
    expect(chain.validateTokenIdentifier(undefined)).toBe(true);
    expect(StellarChain.toClassicAccountId(muxed)).toBe(SENDER.address);
    expect(addressFor(CHAIN_ID_STELLAR_MAINNET, muxed).canonical()).toBe(muxed);
    expect(() => addressFor(CHAIN_ID_STELLAR_MAINNET, CONTRACT)).toThrow();
    expect(chain.getAssetExplorerUrl(sac(chain))).toBe(`https://stellar.expert/explorer/public/asset/USDC-${USDC_ISSUER}`);
    expect(chain.getAssetExplorerUrl(STELLAR_BNUSD)).toBe(`https://stellar.expert/explorer/public/contract/${STELLAR_BNUSD.contractId}`);
    expect(chain.getAssetExplorerUrl(chain.nativeAsset)).toBeNull();
    expect(chain.getTransactionExplorerUrl('ab')).toBe('https://stellar.expert/explorer/public/tx/ab');
    expect(chain.getWalletAddressExplorerUrl(SENDER.address)).toBe(`https://stellar.expert/explorer/public/account/${SENDER.address}`);
    expect(chain.chainAgnosticNamespace).toBe('stellar:pubnet');
    expect(networkTypeOf(CHAIN_ID_STELLAR_MAINNET)).toBe(NetworkType.STELLAR);
    expect(networkTypeOf(-3501)).toBe(NetworkType.STELLAR);
    expect(String(chain)).toBe(`StellarChain[chain_id:${CHAIN_ID_STELLAR_MAINNET}]`);
    expect(await chain.getChainTipHeight()).toBe(64747332);
    expect(await chain.getAccountNextSequence(muxed)).toBe(100n);
  });

  it('verifyMessageSignature takes the G address as the signer', async () => {
    const { chain } = fakeChain();
    const signed = SENDER.signMessage('Hello World!');
    expect(await chain.verifyMessageSignature({ message: 'Hello World!', signer: SENDER.address, signature: signed.signature })).toBe(true);
    expect(await chain.verifyMessageSignature({ message: 'Hello World!', signer: RECEIVER.address, signature: signed.signature })).toBe(false);
    expect(() => StellarChain.verifySignature(SENDER.address, 'x', { signature: 'ab' } as StellarSignedMessage)).toThrow(/StellarSignedMessage/);
  });

  it('Horizon/Soroban URL resolution follows <NAME>_* then STELLAR_<id>_* then the defaults', () => {
    const make = () =>
      new StellarChain({
        name: 'Stellar Env Probe',
        defaultHorizonUrl: 'https://h.default',
        defaultSorobanRpcUrl: 'https://s.default',
        explorerUrl: 'https://x',
        stellarExpertApiUrl: 'https://y',
        networkPassphrase: Networks.TESTNET,
        chainId: -3501,
        chainAgnosticStellarIdentifier: 'testnet',
      });
    const saved = { ...process.env };
    try {
      for (const k of ['STELLAR_ENV_PROBE_HORIZON_URL', 'STELLAR_-3501_HORIZON_URL', 'STELLAR_ENV_PROBE_SOROBAN_RPC_URL', 'STELLAR_-3501_SOROBAN_RPC_URL']) delete process.env[k];
      expect([make()._loadHorizonUrl(), make()._loadSorobanRpcUrl()]).toEqual(['https://h.default', 'https://s.default']);
      process.env['STELLAR_-3501_HORIZON_URL'] = 'https://h.id';
      process.env['STELLAR_-3501_SOROBAN_RPC_URL'] = 'https://s.id';
      expect([make()._loadHorizonUrl(), make()._loadSorobanRpcUrl()]).toEqual(['https://h.id', 'https://s.id']);
      process.env.STELLAR_ENV_PROBE_HORIZON_URL = 'https://h.name';
      process.env.STELLAR_ENV_PROBE_SOROBAN_RPC_URL = 'https://s.name';
      expect([make()._loadHorizonUrl(), make()._loadSorobanRpcUrl()]).toEqual(['https://h.name', 'https://s.name']);
    } finally {
      process.env = saved;
    }
  });

  it('TS adapter createTransferUnsignedTransaction maps amount/memo and refuses isFullBalance', async () => {
    const { chain } = fakeChain();
    const tx = await chain.createTransferUnsignedTransaction({ from: SENDER.address, to: RECEIVER.address, amount: 25_000_000n, memo: 'm' });
    expect((Operation.fromXDRObject(tx.operations[0]) as Operation.Payment).amount).toBe('2.5000000');
    expect(tx.memo?.value?.toString()).toBe('m');
    await expect(chain.createTransferUnsignedTransaction({ from: SENDER.address, to: RECEIVER.address, isFullBalance: true })).rejects.toThrow(/isFullBalance/);
  });

  it('TS adapter refuses a SAC transfer whose receiver still needs the trustline step, and builds it once the step is met', async () => {
    const { chain } = fakeChain();
    const usdc = sac(chain);
    chain.resolveAsset = async () => usdc;
    const request = { from: SENDER.address, to: RECEIVER.address, tokenIdentifier: usdc.contractId, amount: 5_000_000n };
    const receiverBalances = (limit: string | null) => async (id: string) => {
      if (id !== RECEIVER.address) throw new Error(`unexpected account ${id}`);
      if (limit === null) throw new NotFoundError('Not Found', {});
      const usdcLine = { asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: USDC_ISSUER, balance: '0', limit };
      return { balances: limit === '' ? [] : [usdcLine] } as never;
    };

    chain._loadAccountData = receiverBalances(StellarAsset.TRUST_LINE_MAX_LIMIT);
    const tx = await chain.createTransferUnsignedTransaction(request);
    expect((Operation.fromXDRObject(tx.operations[0]) as Operation.Payment).amount).toBe('0.5000000');

    for (const limit of ['', '1000', null]) {
      chain._loadAccountData = receiverBalances(limit);
      await expect(chain.createTransferUnsignedTransaction(request)).rejects.toMatchObject({
        kind: ChainErrorKinds.InvalidArgument,
        message: expect.stringContaining('needs a prerequisite the receiver must handle first'),
      });
    }
  });

  it('getTransfersFromDiagnosisEvents extracts SEP-41 transfers', () => {
    const metaXdr = Object.values(recordings.expert)[0].meta;
    const transfers = StellarChain.getTransfersFromDiagnosisEvents(xdr.TransactionMeta.fromXDR(metaXdr, 'base64').v4().diagnosticEvents());
    expect(transfers.length).toBeGreaterThan(0);
    for (const t of transfers) {
      expect(StrKey.isValidContract(t.tokenContractId)).toBe(true);
      expect(typeof t.amountMr).toBe('bigint');
    }
  });
});
