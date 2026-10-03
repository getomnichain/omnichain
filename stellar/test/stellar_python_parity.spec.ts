import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { inspect } from 'node:util';

import {
  Account,
  Asset as StellarSdkAsset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk';
import { Decimal } from 'decimal.js';

import { AssetMap } from '../../asset_map.ts';
import { FiatCurrency } from '../../chain_type.ts';
import { CHAIN_ID_STELLAR_MAINNET } from '../../chain_ids.ts';
import { ChainError, ChainErrorKinds } from '../../errors.ts';
import { AssetBalanceChange } from '../../transaction_status.ts';
import { EvmToken } from '../../evm/evm_token.ts';
import { StellarAsset } from '../stellar_asset.ts';
import { STELLAR_MAINNET_STABLECOINS_PEG, STELLAR_USDC } from '../stellar_assets.ts';
import { StellarChain, StellarSignedMessage, scvalToUtf8String } from '../stellar_chain.ts';
import { StellarMainnet } from '../stellar_chains.ts';
import { StellarGasPricing } from '../stellar_gas_pricing.ts';
import {
  StellarChangeTrustLineTransactionPrerequisite,
  StellarChangeTrustPrerequisiteResponse,
  StellarSignedTransaction,
  StellarTransactionSimulationResult,
  StellarUnsignedTransaction,
  stellarOperationAmount,
} from '../stellar_transactions.ts';
import { StellarTransactionStatus } from '../stellar_transaction_status.ts';
import { StellarWallet } from '../stellar_wallet.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SENDER = StellarWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/148'/0'" });
const RECEIVER = StellarWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/148'/1'" });
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

interface HorizonReply {
  status: number;
  body: unknown;
}

interface HorizonStub {
  url: string;
  requests: string[];
  ledgers: HorizonReply;
  submit: HorizonReply;
  close: () => Promise<void>;
}

async function startHorizon(): Promise<HorizonStub> {
  const stub = {
    requests: [] as string[],
    ledgers: { status: 200, body: {} } as HorizonReply,
    submit: { status: 200, body: {} } as HorizonReply,
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      stub.requests.push(`${req.method} ${req.url}`);
      const reply =
        req.url?.startsWith('/ledgers') === true
          ? stub.ledgers
          : req.url === '/transactions' && req.method === 'POST'
            ? stub.submit
            : { status: 404, body: { type: 'https://stellar.org/horizon-errors/not_found', title: 'Resource Missing', status: 404 } };
      res.writeHead(reply.status, { 'Content-Type': 'application/hal+json; charset=utf-8' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(stub, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

function chainOn(horizonUrl: string): StellarChain {
  return new StellarChain({
    name: 'Stellar Local Horizon',
    defaultHorizonUrl: horizonUrl,
    defaultSorobanRpcUrl: 'http://127.0.0.1:9',
    explorerUrl: 'https://stellar.expert/explorer/public',
    stellarExpertApiUrl: 'https://api.stellar.expert/explorer/public',
    networkPassphrase: Networks.PUBLIC,
    chainId: CHAIN_ID_STELLAR_MAINNET,
    chainAgnosticStellarIdentifier: 'pubnet',
  });
}

function ledgersPage(records: unknown[]): unknown {
  const href = 'http://127.0.0.1/ledgers?order=desc&limit=1';
  return { _links: { self: { href }, next: { href }, prev: { href } }, _embedded: { records } };
}

function signedPaymentXdr(): string {
  const tx = new TransactionBuilder(new Account(SENDER.address, '100'), { fee: '100', networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.payment({ destination: RECEIVER.address, asset: StellarSdkAsset.native(), amount: '1' }))
    .setTimeout(300)
    .build();
  tx.sign(Keypair.fromSecret(SENDER.secretSeed));
  return tx.toXDR();
}

function feeBumpXdr(): string {
  const inner = TransactionBuilder.fromXDR(signedPaymentXdr(), Networks.PUBLIC);
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(Keypair.fromSecret(SENDER.secretSeed), '200', inner as never, Networks.PUBLIC);
  feeBump.sign(Keypair.fromSecret(SENDER.secretSeed));
  return feeBump.toXDR();
}

describe('Horizon over real HTTP (stellar-sdk http client, not hand-built errors)', () => {
  let horizon: HorizonStub;

  beforeAll(async () => {
    horizon = await startHorizon();
  });

  afterAll(async () => {
    await horizon.close();
  });

  beforeEach(() => {
    horizon.requests.length = 0;
  });

  it('getBaseFee reads base_fee_in_stroops of the latest ledger, like Python fetch_base_fee', async () => {
    horizon.ledgers = { status: 200, body: ledgersPage([{ sequence: 1, base_fee_in_stroops: 250 }]) };
    await expect(chainOn(horizon.url).getBaseFee()).resolves.toBe(250);
    expect(horizon.requests).toEqual(['GET /ledgers?order=desc&limit=1']);

    horizon.ledgers = { status: 200, body: ledgersPage([]) };
    await expect(chainOn(horizon.url).getBaseFee()).resolves.toBe(100);

    horizon.ledgers = { status: 200, body: { _links: {} } };
    await expect(chainOn(horizon.url).getBaseFee()).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError });
  });

  it('a Horizon 400 on submit is BroadcastRejected with the result codes; 5xx stays RpcError', async () => {
    const chain = chainOn(horizon.url);
    const xdr = signedPaymentXdr();
    horizon.submit = {
      status: 400,
      body: {
        type: 'https://stellar.org/horizon-errors/transaction_failed',
        title: 'Transaction Failed',
        status: 400,
        extras: { result_codes: { transaction: 'tx_bad_seq' } },
      },
    };
    const rejected = await chain.broadcast(xdr).catch((err: unknown) => err);
    expect(rejected).toBeInstanceOf(ChainError);
    expect(rejected).toMatchObject({ kind: ChainErrorKinds.BroadcastRejected });
    expect((rejected as ChainError).message).toContain('{"transaction":"tx_bad_seq"}');
    expect(horizon.requests).toContain('POST /transactions');

    horizon.submit = { status: 504, body: { type: 'https://stellar.org/horizon-errors/timeout', title: 'Timeout', status: 504 } };
    await expect(chain.broadcast(xdr)).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError });

    const hash = new StellarSignedTransaction({ chainId: chain.chainId, signedXdr: xdr, networkPassphrase: Networks.PUBLIC }).txHash;
    horizon.submit = { status: 200, body: { hash } };
    await expect(chain.broadcast(xdr)).resolves.toBe(hash);
  });

  it('fee-bump XDR is rejected with Python\'s "Unexpected EnvelopeType: 5." before any request', async () => {
    const chain = chainOn(horizon.url);
    const feeBump = feeBumpXdr();
    const signed = new StellarSignedTransaction({ chainId: chain.chainId, signedXdr: feeBump, networkPassphrase: Networks.PUBLIC });
    expect(() => signed.txHash).toThrow('Unexpected EnvelopeType: 5.');
    await expect(chain.broadcastSignedTransaction(signed)).rejects.toThrow('Unexpected EnvelopeType: 5.');
    await expect(chain.broadcast(feeBump)).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
    expect(horizon.requests).toEqual([]);
  });
});

describe('operation amounts follow stellar-sdk raise_if_not_valid_amount and raise ChainError, never a raw TypeError', () => {
  it.each([
    ['-1', 'amount', 'Value of argument "amount" must represent a positive number and the max valid value is 922337203685.4775807: -1'],
    ['922337203685.4775808', 'amount', 'Value of argument "amount" must represent a positive number and the max valid value is 922337203685.4775807: 922337203685.4775808'],
    ['1.00000001', 'send_amount', 'Value of argument "send_amount" must have at most 7 digits after the decimal: 1.00000001'],
    ['0', 'dest_min', 'Value of argument "dest_min" must be greater than zero: the Stellar network rejects a zero dest_min'],
  ])('%s as %s', (value, argument, message) => {
    expect(() => stellarOperationAmount(new Decimal(value), argument)).toThrow(new ChainError(ChainErrorKinds.InvalidArgument, message));
  });

  it('a ChangeTrust limit of 0 is allowed (closes the trustline), like Python', () => {
    expect(stellarOperationAmount(new Decimal(0), 'limit', { allowZero: true })).toBe('0');
    expect(stellarOperationAmount(new Decimal('922337203685.4775807'), 'limit', { allowZero: true })).toBe('922337203685.4775807');
  });

  it('a zero classic transfer is a ChainError(InvalidArgument)', async () => {
    const chain = chainOn('http://127.0.0.1:9');
    const attempt = chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal(0),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER.address,
    });
    await expect(attempt).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
    await expect(attempt).rejects.toBeInstanceOf(ChainError);
  });
});

describe('Python value semantics for assets', () => {
  it('peg and wallet-balance maps look assets up by value (Python dict), not by object identity', () => {
    const freshUsdc = StellarMainnet.createSacToken('USDC', USDC_ISSUER);
    expect(freshUsdc).not.toBe(STELLAR_USDC);
    expect(STELLAR_MAINNET_STABLECOINS_PEG.get(freshUsdc)).toBe(FiatCurrency.USD);
    expect(STELLAR_MAINNET_STABLECOINS_PEG.has(StellarMainnet.nativeAsset)).toBe(false);

    const balances = new AssetMap<StellarAsset, Decimal>();
    balances.set(STELLAR_USDC, new Decimal(1));
    balances.set(freshUsdc, new Decimal(2));
    expect(balances.size).toBe(1);
    expect([...balances.keys()][0]).toBe(STELLAR_USDC);
    expect(balances.get(StellarMainnet.createSacToken('USDC', USDC_ISSUER))?.toString()).toBe('2');
    expect(balances.delete(freshUsdc)).toBe(true);
    expect(balances.size).toBe(0);
  });

  it('a non-SAC token whose symbol() is empty is a valid asset; other families keep rejecting empty symbols', () => {
    const token = new StellarAsset({
      chainId: CHAIN_ID_STELLAR_MAINNET,
      networkPassphrase: Networks.PUBLIC,
      code: '',
      issuer: null,
      contractId: 'CCT4ZYIYZ3TUO2AWQFEOFGBZ6HQP3GW5TA37CK7CRZVFRDXYTHTYX7KP',
      decimals: 18,
    });
    expect(token.symbol).toBe('');
    expect(() => new EvmToken(1, '', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 18)).toThrow('Token symbol is required');
  });

  it('an invalid SAC code raises Python\'s AssetCodeInvalidError text as a ChainError', () => {
    expect(() => StellarMainnet.createSacToken('US-D', USDC_ISSUER)).toThrow(
      new ChainError(ChainErrorKinds.InvalidArgument, 'Asset code is invalid (maximum alphanumeric, 12 characters at max).'),
    );
  });

  it('__str__ texts print None / True like Python', () => {
    const response = new StellarChangeTrustPrerequisiteResponse({ skipped: true, txHash: null });
    expect(String(response)).toBe('StellarChangeTrustPrerequisiteResponse[skipped=True, tx_hash=None]');
    expect(String(StellarMainnet.nativeAsset)).toContain('issuer:None,');
    const unsigned = new StellarUnsignedTransaction({ chainId: CHAIN_ID_STELLAR_MAINNET, sourceAccountId: SENDER.address, operations: [] });
    expect(String(unsigned)).toBe(`StellarUnsignedTransaction[source_account_id:${SENDER.address}, operations:0, base_fee:None, memo:None]`);
  });
});

describe('wallet secrets and Python hex parsing', () => {
  it('the secret seed is readable through the accessor but never serialized or inspected', () => {
    expect(SENDER.secretSeed.startsWith('S')).toBe(true);
    expect(JSON.stringify(SENDER)).not.toContain(SENDER.secretSeed);
    expect(inspect(SENDER, { depth: 10, showHidden: true })).not.toContain(SENDER.secretSeed);
    expect(Object.keys(SENDER)).not.toContain('secretSeed');
  });

  it('verifySignature parses the hex like bytes.fromhex: whitespace is skipped, 0x is not hex', () => {
    const signature = SENDER.signMessage('hello').signature;
    const spaced = signature.replace(/(.{8})/g, '$1 ');
    expect(StellarChain.verifySignature(SENDER.address, 'hello', new StellarSignedMessage(` ${spaced}\n`))).toBe(true);
    expect(StellarChain.verifySignature(SENDER.address, 'hello', new StellarSignedMessage(`0x${signature}`))).toBe(false);
  });

  it('prerequisite errors use Python\'s message text, including type() rendering', async () => {
    const chain = chainOn('http://127.0.0.1:9');
    const foreign = new StellarChangeTrustLineTransactionPrerequisite({
      chainId: CHAIN_ID_STELLAR_MAINNET,
      code: 'USDC',
      issuer: USDC_ISSUER,
      limit: new Decimal(10),
      walletAddress: RECEIVER.address,
    });
    Object.defineProperty(chain, 'getTrustLineLimit', { value: async () => ({ balance: new Decimal(0), limit: new Decimal(0) }) });
    await expect(SENDER.handleTransactionPrerequisite(foreign, chain)).rejects.toThrow(
      `Prerequisite not handled and does not belong to Stellar wallet ${SENDER.address}, so it cannot behandled. Prerequisite ${String(foreign)} of type <class 'StellarChangeTrustLineTransactionPrerequisite'>`,
    );
  });
});

describe('round-2 parity: Python-typed failures instead of raw SDK errors', () => {
  it('a text memo over 28 bytes raises stellar-sdk MemoInvalidException text', async () => {
    const chain = chainOn('http://127.0.0.1:9');
    const attempt = chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal(1),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER.address,
      memoText: '\u00e9'.repeat(15),
      gasPricing: new StellarGasPricing({ baseFeeStroops: 100 }),
    });
    await expect(attempt).rejects.toThrow(new Error('Text should be <= 28 bytes (ascii encoded), got 30 bytes.'));
  });

  it('an invalid contract id fails like append_invoke_contract_function_op, before any RPC', async () => {
    const chain = chainOn('http://127.0.0.1:9');
    await expect(chain.resolveAsset(SENDER.address)).rejects.toMatchObject({
      kind: ChainErrorKinds.InvalidTokenIdentifier,
      message: '`contract_id` is invalid.',
    });
    await expect(chain.getBalance(SENDER.address, 'not-a-contract')).rejects.toThrow('`contract_id` is invalid.');
  });

  it('a transfer event with fewer than 3 topics raises IndexError text; strings decode strictly and keep a BOM', () => {
    const contractId = Buffer.alloc(32, 7);
    const event = (topics: xdr.ScVal[]) =>
      new xdr.DiagnosticEvent({
        inSuccessfulContractCall: true,
        event: new xdr.ContractEvent({
          ext: new xdr.ExtensionPoint(0),
          contractId: contractId as unknown as xdr.ContractId,
          type: xdr.ContractEventType.contract(),
          body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data: nativeToScVal(5n, { type: 'i128' }) })),
        }),
      });
    expect(() => StellarChain.getTransfersFromDiagnosisEvents([event([xdr.ScVal.scvSymbol('transfer')])])).toThrow(new Error('list index out of range'));
    expect(scvalToUtf8String(xdr.ScVal.scvString(Buffer.from([0xef, 0xbb, 0xbf, 0x68])))).toBe('\ufeffh');
    expect(() => scvalToUtf8String(xdr.ScVal.scvString(Buffer.from([0xff])))).toThrow(
      new Error("'utf-8' codec can't decode byte 0xff in position 0: invalid start byte"),
    );
  });

  it('StellarUnsignedTransaction.fromXdr rejects a fee-bump envelope with Python\'s text', () => {
    expect(() => StellarUnsignedTransaction.fromXdr(chainOn('http://127.0.0.1:9'), feeBumpXdr())).toThrow(new Error('Unexpected EnvelopeType: 5.'));
  });

  it('a failed Soroban simulation inside prepare raises PrepareTransactionException text; transport stays RpcError', async () => {
    const chain = chainOn('http://127.0.0.1:9');
    const invoke = chain.buildTokenTransferOperation({
      asset: STELLAR_USDC,
      senderAddress: SENDER.address,
      receiverAddress: 'CCLWL5NYSV2WJQ3VBU44AMDHEVKEPA45N2QP2LL62O3JVKPGWWAQUVAG',
      amountHr: new Decimal(1),
    });
    const unsigned = new StellarUnsignedTransaction({ chainId: chain.chainId, sourceAccountId: SENDER.address, operations: [invoke], baseFee: 100 });
    const horizon = { loadAccount: async (id: string) => new Account(id, '1') };
    let prepareError: Error = new Error('host invocation failed');
    Object.defineProperty(chain, 'asyncHorizonServer', { get: () => horizon });
    Object.defineProperty(chain, 'asyncSorobanServer', { get: () => ({ prepareTransaction: async () => Promise.reject(prepareError) }) });
    await expect(unsigned.buildTransactionEnvelope(chain)).rejects.toMatchObject({
      kind: ChainErrorKinds.SimulationFailed,
      message: 'Simulation transaction failed, the response contains error information.',
    });
    prepareError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await expect(unsigned.buildTransactionEnvelope(chain)).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError });
  });

  it('signing a message with a lone surrogate raises UnicodeEncodeError text; verification returns false', () => {
    expect(() => SENDER.signMessage('a\ud800')).toThrow(new Error("'utf-8' codec can't encode character '\\ud800' in position 1: surrogates not allowed"));
    const signature = SENDER.signMessage('a\ufffd').signature;
    expect(StellarChain.verifySignature(SENDER.address, 'a\ud800', new StellarSignedMessage(signature))).toBe(false);
  });
});

describe('round-2 parity: registry, __str__ texts', () => {
  it('StellarAsset.searchRegisteredAsset / getRegisteredAsset use the shared Python-style registry', () => {
    expect(StellarAsset.searchRegisteredAsset(CHAIN_ID_STELLAR_MAINNET, STELLAR_USDC.contractId)?.equals(STELLAR_USDC)).toBe(true);
    expect(StellarAsset.getRegisteredAsset(CHAIN_ID_STELLAR_MAINNET, 'USDC', STELLAR_USDC.contractId)?.equals(STELLAR_USDC)).toBe(true);
    expect(StellarAsset.searchRegisteredAsset(CHAIN_ID_STELLAR_MAINNET, 'CDOESNOTEXIST')).toBeNull();
  });

  it('status and simulation results print like Python __str__', () => {
    const changes = new Map([[SENDER.address, new Map([['xlm', { token: StellarMainnet.nativeAsset, change: AssetBalanceChange.fromMr(-15_000_000n, 7) }]])]]);
    const status = StellarTransactionStatus.successful({
      chainId: CHAIN_ID_STELLAR_MAINNET,
      inclusionAt: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
      balanceChanges: changes,
      horizonPagingToken: '123',
    });
    expect(String(status)).toBe(
      `StellarTransactionStatus[chainId:${CHAIN_ID_STELLAR_MAINNET}, status_type:Success, fee:None, paging_token:123, balance_changes:{'${SENDER.address}': {${String(StellarMainnet.nativeAsset)}: [change:-1.5]}}, error:None, memo:None)]`,
    );
    const simulation = new StellarTransactionSimulationResult({
      chainId: CHAIN_ID_STELLAR_MAINNET,
      statusType: 'Failed',
      balanceChanges: new Map(),
      error: new Error('nope'),
      transactionType: 'payment',
    });
    expect(String(simulation)).toBe(
      `StellarTransactionSimulationResult[chain_id:${CHAIN_ID_STELLAR_MAINNET},status:Failed,balance_changes:{},error:nope,fees:None,transaction_type:payment,memo:None,]`,
    );
  });

  it('an invalid account uses MuxedAccount.from_account text', () => {
    expect(() => StellarChain.toClassicAccountId('bad')).toThrow(/^This is not a valid account: bad$/);
  });
});
