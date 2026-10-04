import { readFileSync } from 'node:fs';
import { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { Decimal } from 'decimal.js';
import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

import { FiatCurrency } from '../../chain_type.ts';
import { CHAIN_ID_TRON_MAINNET } from '../../chain_ids.ts';
import { NetworkType, networkTypeRegistrations, tryNetworkTypeOf } from '../../network_type.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { TronAsset } from '../tron_asset.ts';
import { TRON_MAINNET_STABLECOINS_PEG, TRON_TRX } from '../tron_assets.ts';
import { TronAddressUtils, TronChain, TronSignedMessage } from '../tron_chain.ts';
import { TRONPY_USER_AGENT, TronClient, TronJson, TronTvmError } from '../tron_client.ts';
import { TronContract } from '../tron_contract.ts';
import { tronAbiDecodeSingle, tronAbiEncodeSingle } from '../tron_abi.ts';
import { TronPrivateKey, TronPublicKey, TronSignature } from '../tron_keys.ts';
import { TronApproveTransactionPrerequisite, TronHandledApprovePrerequisiteResponse, TronSignedTransaction, TronUnsignedTransaction, TronTransactionSimulationResult, tronTransactionFromJson } from '../tron_transactions.ts';
import { TronTransactionStatus } from '../tron_transaction_status.ts';
import { TronWallet } from '../tron_wallet.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET = TronWallet.fromMnemonic(MNEMONIC);
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const BLOCK_ID = '0000000004a3b2c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5';

interface TronpyTexts {
  revert_hex: Record<string, string>;
  tvm: Record<string, [string, string]>;
  api: Record<string, [string, string] | null>;
}

const tronpy = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tronpy_error_texts.json'), 'utf8'),
) as TronpyTexts;

interface RecordedRequest {
  path: string;
  headers: IncomingHttpHeaders;
  body: TronJson;
}

interface TronNodeStub {
  url: string;
  requests: RecordedRequest[];
  routes: Record<string, (body: TronJson) => TronJson>;
  rawRoutes: Record<string, (res: ServerResponse) => void>;
  close: () => Promise<void>;
}

async function startNode(): Promise<TronNodeStub> {
  const stub = {
    requests: [] as RecordedRequest[],
    routes: {} as Record<string, (body: TronJson) => TronJson>,
    rawRoutes: {} as Record<string, (res: ServerResponse) => void>,
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/trongrid/, '');
      const body = raw === '' ? {} : (JSON.parse(raw) as TronJson);
      stub.requests.push({ path, headers: req.headers, body });
      const rawRoute = stub.rawRoutes[path];
      if (rawRoute !== undefined) {
        rawRoute(res);
        return;
      }
      const route = stub.routes[path];
      res.writeHead(route === undefined ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(route === undefined ? {} : route(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(stub, {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}

function abiString(value: string): string {
  return AbiCoder.defaultAbiCoder().encode(['string'], [value]).slice(2);
}

describe('TronClient over real HTTP mirrors tronpy AsyncHTTPProvider / AsyncTron', () => {
  let node: TronNodeStub;

  beforeAll(async () => {
    node = await startNode();
  });

  afterAll(async () => {
    await node.close();
  });

  beforeEach(() => {
    node.requests.length = 0;
    node.routes = {};
    node.rawRoutes = {};
  });

  it('a connection dropped after the 200 headers is RpcError, and the broadcast adapter never calls it rejected', async () => {
    node.rawRoutes['/wallet/broadcasttransaction'] = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"result": tr');
      setTimeout(() => res.socket?.destroy(), 20);
    };
    const chain = new TronChain({ name: 'Tron Local Node', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: node.url, explorerUrl: 'https://tronscan.org' });
    const transaction = tronTransactionFromJson({ txID: 'aa'.repeat(32), raw_data: { expiration: Date.now() + 60_000 }, signature: ['00'], permission: null });
    const signed = new TronSignedTransaction({ chainId: CHAIN_ID_TRON_MAINNET, signedTransaction: transaction });
    const response = await chain.broadcastSignedTransaction(signed);
    expect(response.broadcastError).toMatchObject({ kind: ChainErrorKinds.RpcError });
    await expect(chain.broadcast(signed.toJsonStr())).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError, meta: { txHash: 'aa'.repeat(32) } });
  });

  it('the read timeout applies per chunk like httpx: a slow but live body succeeds, a stalled one is RpcError', async () => {
    const client = new TronClient({ endpointUri: node.url, timeoutMs: 300 });
    node.rawRoutes['/wallet/getnodeinfo'] = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const parts = ['{"block": ', '"Num:7', ',ID:00"', '}'];
      parts.forEach((part, i) => setTimeout(() => (i === parts.length - 1 ? res.end(part) : res.write(part)), 200 * (i + 1)));
    };
    await expect(client.getLatestBlockNumber()).resolves.toBe(7);
    node.rawRoutes['/wallet/getnodeinfo'] = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"block": ');
    };
    await expect(client.getLatestBlockNumber()).rejects.toMatchObject({
      kind: ChainErrorKinds.RpcError,
      message: expect.stringContaining('timed out after 300 ms'),
    });
  });

  it('a 200 body that is not JSON never reaches the error text, so an echoed API key cannot leak', async () => {
    node.rawRoutes['/wallet/getnodeinfo'] = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>{"tron-pro-api-key":"SECRET-KEY-must-not-leak"}</html>');
    };
    const client = new TronClient({ endpointUri: `${node.url}trongrid/`, apiKey: 'SECRET-KEY-must-not-leak' });
    const failure = await client.getNodeInfo().then(
      () => null,
      (err: Error) => err,
    );
    expect(failure).toMatchObject({ kind: ChainErrorKinds.RpcError });
    expect(failure?.message).not.toContain('SECRET-KEY');
    expect(failure?.message).not.toContain('<html>');
  });

  it('a JSON reply that is not an object fails like Python\'s payload.get, without echoing the reply', async () => {
    const client = new TronClient({ endpointUri: `${node.url}trongrid/`, apiKey: 'SECRET-KEY-must-not-leak' });
    const replies: [string, string][] = [
      ['"tron-pro-api-key: SECRET-KEY-must-not-leak"', 'str'],
      ['[1]', 'list'],
      ['null', 'NoneType'],
      ['5', 'int'],
      ['true', 'bool'],
    ];
    for (const [raw, typeName] of replies) {
      node.rawRoutes['/wallet/getaccount'] = (res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(raw);
      };
      const failure = await client.getAccountBalance('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').then(
        () => null,
        (err: Error) => err,
      );
      expect(failure).toMatchObject({ kind: ChainErrorKinds.RpcError, message: `'${typeName}' object has no attribute 'get'` });
    }
  });

  it('never follows a redirect (httpx default) and never forwards the API key elsewhere', async () => {
    const elsewhere = await startNode();
    try {
      elsewhere.routes['/wallet/getnodeinfo'] = () => ({ block: 'Num:1,ID:00' });
      node.rawRoutes['/wallet/getnodeinfo'] = (res) => {
        res.writeHead(307, { Location: `${elsewhere.url}wallet/getnodeinfo` });
        res.end();
      };
      const client = new TronClient({ endpointUri: `${node.url}trongrid/`, apiKey: 'redirect-probe-key' });
      const error = await client.getNodeInfo().catch((err: unknown) => err);
      expect(error).toMatchObject({ kind: ChainErrorKinds.RpcError });
      expect((error as Error).message).toContain("Redirect response '307 Temporary Redirect' for url");
      expect((error as Error).message).toContain(`Redirect location: '${elsewhere.url}wallet/getnodeinfo'`);
      expect(elsewhere.requests).toEqual([]);
    } finally {
      await elsewhere.close();
    }
  });

  it('non-2xx answers carry httpx raise_for_status text; a TronGrid daily-limit 403 is tronpy\'s ApiError text', async () => {
    const client = new TronClient({ endpointUri: `${node.url}trongrid/`, apiKey: 'k' });
    await expect(client.getNodeInfo()).rejects.toThrow(
      `Client error '404 Not Found' for url '${node.url}wallet/getnodeinfo'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/404`,
    );
    node.rawRoutes['/wallet/getnodeinfo'] = (res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"Error": "Exceed the user daily usage (100000), the maximum query frequency is 1 time per second"}');
    };
    await expect(client.getNodeInfo()).rejects.toThrow(new Error('rate limit! please add more API keys'));
  });

  it('sends the tronpy User-Agent; the API key header only goes to trongrid endpoints', async () => {
    node.routes['/wallet/getnodeinfo'] = () => ({ solidityBlock: `Num:1,ID:${BLOCK_ID}` });
    await new TronClient({ endpointUri: `${node.url}trongrid/`, apiKey: 'test-key-1' }).getNodeInfo();
    await new TronClient({ endpointUri: node.url, apiKey: 'test-key-2' }).getNodeInfo();
    expect(node.requests.map((r) => r.headers['user-agent'])).toEqual([TRONPY_USER_AGENT, TRONPY_USER_AGENT]);
    expect(TRONPY_USER_AGENT).toBe('Tronpy/0.6.2');
    expect(node.requests[0].headers['tron-pro-api-key']).toBe('test-key-1');
    expect(node.requests[1].headers['tron-pro-api-key']).toBeUndefined();
  });

  it('getLatestSolidBlockId falls back to walletsolidity/getnowblock when getnodeinfo has no solidityBlock', async () => {
    const client = new TronClient({ endpointUri: node.url });
    node.routes['/wallet/getnodeinfo'] = () => ({ solidityBlock: `Num:1,ID:${BLOCK_ID}` });
    await expect(client.getLatestSolidBlockId()).resolves.toBe(BLOCK_ID);

    node.routes['/wallet/getnodeinfo'] = () => ({ Error: 'node busy' });
    node.routes['/walletsolidity/getnowblock'] = () => ({ blockID: 'bb'.repeat(32) });
    await expect(client.getLatestSolidBlockId()).resolves.toBe('bb'.repeat(32));
    expect(node.requests.slice(-2).map((r) => r.path)).toEqual(['/wallet/getnodeinfo', '/walletsolidity/getnowblock']);

    node.routes['/walletsolidity/getnowblock'] = () => ({});
    await expect(client.getLatestSolidBlockId()).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError });
  });

  it('getLatestBlockNumber fails instead of returning NaN on a malformed getnodeinfo', async () => {
    const client = new TronClient({ endpointUri: node.url });
    node.routes['/wallet/getnodeinfo'] = () => ({ block: `Num:77775570,ID:${BLOCK_ID}` });
    await expect(client.getLatestBlockNumber()).resolves.toBe(77775570);
    node.routes['/wallet/getnodeinfo'] = () => ({});
    await expect(client.getLatestBlockNumber()).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError });
    node.routes['/wallet/getnodeinfo'] = () => ({ block: 'Num:x,ID:00' });
    await expect(client.getLatestBlockNumber()).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError });
  });

  it.each(Object.keys(tronpy.tvm))('a reverted constant call gives tronpy\'s TvmError text (%s)', async (name) => {
    node.routes['/wallet/triggerconstantcontract'] = () => ({
      result: { result: true, message: 'REVERT opcode executed' },
      constant_result: [tronpy.revert_hex[name]],
    });
    const error = await new TronClient({ endpointUri: node.url })
      .triggerConstantContract(USDT_CONTRACT, USDT_CONTRACT, 'f()', '')
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TronTvmError);
    expect((error as Error).message).toBe(tronpy.tvm[name][1]);
  });

  it('a malformed getcontract reply fails like tronpy AsyncContract construction, after one RPC', async () => {
    const cases: [TronJson, string][] = [
      [{ bytecode: null }, 'bad bytes format'],
      [{ bytecode: 'xyz' }, 'non-hexadecimal number found in fromhex() arg at position 0'],
      [{ abi: [] }, "'list' object has no attribute 'get'"],
      [{ abi: null }, "'NoneType' object has no attribute 'get'"],
      [{ bytecode: 'xyz', abi: [] }, "'list' object has no attribute 'get'"],
    ];
    const chain = new TronChain({ name: 'Tron Local Node', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: node.url, explorerUrl: 'https://tronscan.org' });
    for (const [reply, message] of cases) {
      node.requests.length = 0;
      node.routes['/wallet/getcontract'] = () => reply;
      await expect(chain.getAssetBalance(chain.getTrc20Asset('USDC', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 6), WALLET.address)).rejects.toThrow(message);
      expect(node.requests.map((r) => r.path)).toEqual(['/wallet/getcontract']);
    }
  });

  it('resolveAsset accepts a TRC-20 whose symbol() is empty, like Python', async () => {
    node.routes['/wallet/getcontract'] = (body) => ({ contract_address: body.value });
    node.routes['/wallet/triggerconstantcontract'] = (body) => ({
      result: { result: true },
      constant_result: [body.function_selector === 'decimals()' ? (6).toString(16).padStart(64, '0') : abiString('')],
    });
    const chain = new TronChain({ name: 'Tron Local Node', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: node.url, explorerUrl: 'https://tronscan.org' });
    const asset = await chain.resolveAsset('TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8');
    expect(asset.symbol).toBe('');
    expect(asset.decimals).toBe(6);
  });
});

describe('TronGrid API errors carry tronpy\'s exception text', () => {
  const client = new TronClient({ endpointUri: 'http://127.0.0.1:9/' });
  const payloads: Record<string, TronJson> = {
    sigerror: { code: 'SIGERROR', message: Buffer.from('bad sig').toString('hex') },
    dup: { code: 'DUP_TRANSACTION_ERROR', message: Buffer.from('dup transaction').toString('hex') },
    tapos: { code: 'TAPOS_ERROR', message: Buffer.from('Tapos check error').toString('hex') },
    too_big: { code: 'TOO_BIG_TRANSACTION_ERROR', message: Buffer.from('too big').toString('hex') },
    contract_validate: { code: 'CONTRACT_VALIDATE_ERROR', message: 'Validate TransferContract error, balance is not sufficient.' },
    spaced_hex: { code: 'OTHER_ERROR', message: '61 62\n63' },
    no_message: { code: 'SERVER_BUSY' },
    numeric_message: { code: 'OTHER_ERROR', message: 12 },
    error_key: { Error: 'class java.lang.NullPointerException : null' },
    nested: { result: { code: 'SIGERROR', message: '6e6f7065' } },
  };

  it.each(Object.keys(payloads))('%s', (name) => {
    const expected = tronpy.api[name];
    if (expected === null) {
      expect(() => client.handleApiError(payloads[name])).not.toThrow();
      return;
    }
    expect(() => client.handleApiError(payloads[name])).toThrow(new Error(expected[1]));
  });

  it('keeps the node code; only the broadcast adapter decides whether a code means "not accepted"', () => {
    expect(() => client.handleApiError(payloads.too_big)).toThrow(expect.objectContaining({ kind: ChainErrorKinds.TransactionTooLarge }));
    expect(() => client.handleApiError(payloads.dup)).toThrow(expect.objectContaining({ kind: ChainErrorKinds.RpcError, code: 'DUP_TRANSACTION_ERROR' }));
    expect(() => client.handleApiError({ result: { code: 'CONTRACT_VALIDATE_ERROR', message: '' } })).toThrow(
      expect.objectContaining({ kind: ChainErrorKinds.RpcError, code: 'CONTRACT_VALIDATE_ERROR' }),
    );
  });
});

describe('Tron keys and wallet: Python hex parsing and no secret exposure', () => {
  it('a private key with surrounding whitespace is accepted (bytes.fromhex) and errors never echo the key', () => {
    const spaced = new TronWallet(` ${WALLET.privateKeyHex}\n`);
    expect(spaced.address).toBe(WALLET.address);
    const corrupted = `${WALLET.privateKeyHex.slice(0, 20)}zz${WALLET.privateKeyHex.slice(22)}`;
    expect(() => new TronWallet(corrupted)).toThrow('non-hexadecimal number found in fromhex() arg at position 20');
    try {
      new TronWallet(corrupted);
    } catch (err) {
      expect((err as Error).message).not.toContain(WALLET.privateKeyHex.slice(0, 20));
    }
    expect(() => TronPrivateKey.fromHex(`0x${WALLET.privateKeyHex}`)).toThrow('non-hexadecimal number found in fromhex() arg at position 1');
  });

  it('wallet, key, client and chain never serialize or inspect the secret', () => {
    const secret = WALLET.privateKeyHex;
    const key = TronPrivateKey.fromHex(secret);
    const chain = new TronChain({
      name: 'Tron Secret Probe',
      chainId: CHAIN_ID_TRON_MAINNET,
      defaultRpcUrl: 'https://api.trongrid.io',
      explorerUrl: 'https://tronscan.org',
      trongridApiKey: 'api-key-must-not-leak',
    });
    void chain.client;
    for (const value of [WALLET, key]) {
      expect(JSON.stringify(value)).not.toContain(secret);
      expect(inspect(value, { depth: 10, showHidden: true, getters: true })).not.toContain(secret);
    }
    expect(JSON.stringify(chain)).not.toContain('api-key-must-not-leak');
    expect(inspect(chain, { depth: 10, showHidden: true, getters: true })).not.toContain('api-key-must-not-leak');
    expect(WALLET.privateKeyHex).toBe(secret);
  });

  it('TronChain.verifySignature parses like Python; the TS adapter still takes TronWeb 0x signatures', async () => {
    const signature = WALLET.signMessage('hello').signature;
    expect(TronChain.verifySignature(WALLET.publicKey, 'hello', new TronSignedMessage(` ${signature} `))).toBe(true);
    expect(TronChain.verifySignature(WALLET.publicKey, 'hello', new TronSignedMessage(`0x${signature}`))).toBe(false);
    const chain = new TronChain({ name: 'Tron Verify', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'https://x.invalid', explorerUrl: 'https://x' });
    await expect(chain.verifyMessageSignature({ signer: WALLET.address, message: 'hello', signature: `0x${signature}` })).resolves.toBe(true);
  });
});

describe('TronContract mirrors tronpy ContractMethod', () => {
  const abi = [
    { type: 'Function', name: 'tokenBalance', stateMutability: 'View', inputs: [{ name: 'id', type: 'trcToken' }], outputs: [{ type: 'trcToken' }] },
    { type: 'Function', name: 'noMutability', inputs: [{ name: 'a', type: 'uint256' }] },
    { type: 'Function', name: 'one', stateMutability: 'view', inputs: [{ name: 'a', type: 'uint256' }], outputs: [] },
  ];
  const contract = new TronContract({ address: USDT_CONTRACT, client: new TronClient({ endpointUri: 'http://127.0.0.1:9/' }), abi });

  it('keeps trcToken in the selector and fails to encode/decode it, exactly like tronpy 0.6.2 + eth_abi 5', async () => {
    const method = contract.method('tokenBalance');
    expect(method.functionSignature).toBe('tokenBalance(trcToken)');
    expect(method.functionSignatureHash).toBe('205e3c9c');
    expect(method.functionSignatureHash).toBe(keccak256(toUtf8Bytes('tokenBalance(trcToken)')).slice(2, 10));
    expect(() => method.prepareParameter([1002000n])).toThrow("Cannot create UnsignedIntegerEncoder for type 'trcToken': expected type with base 'uint'");
    expect(() => method.parseOutput('00'.repeat(32))).toThrow("Cannot create UnsignedIntegerDecoder for type 'trcToken': expected type with base 'uint'");
  });

  it('a method without stateMutability fails like tronpy instead of building a transaction', async () => {
    await expect(contract.method('noMutability').call(1n)).rejects.toThrow("'NoneType' object has no attribute 'lower'");
  });

  it('calling a method with inputs but no arguments uses tronpy\'s message', async () => {
    await expect(contract.method('one').call()).rejects.toThrow(/^wrong number of arguments, require 1$/);
  });
});

describe('Python value semantics for Tron assets and __str__ texts', () => {
  it('the peg map finds a freshly built, equal asset', () => {
    const freshUsdt = new TronAsset(CHAIN_ID_TRON_MAINNET, 'USDT', USDT_CONTRACT, 6);
    expect(TRON_MAINNET_STABLECOINS_PEG.get(freshUsdt)).toBe(FiatCurrency.USD);
    expect(TRON_MAINNET_STABLECOINS_PEG.get(new TronAsset(CHAIN_ID_TRON_MAINNET, 'USDT', USDT_CONTRACT, 18))).toBeUndefined();
  });

  it('prints None / True like Python', () => {
    expect(String(TRON_TRX)).toBe(`TronAsset[${CHAIN_ID_TRON_MAINNET}.TRX--None,decimals=6]`);
    expect(String(new TronHandledApprovePrerequisiteResponse({ skipped: true, txHash: null }))).toBe(
      'TronHandledApprovePrerequisiteResponse[skipped=True, tx_hash=None]',
    );
  });
});

describe('TronTransaction.sign refuses exactly what tronpy AsyncTransaction.sign refuses', () => {
  const key = new TronPrivateKey(new Uint8Array(32).fill(1));
  const future = Date.now() + 60_000;
  const tronpySignature = '2b3bc1430342aac2bcce687aaf5db4b8e0440421616fa3af77c3cba12832f4ea7f3d773f75cfc3733877a842ff0781696f477629c58817b9c61af9687647338300';
  const sign = (payload: TronJson): string[] | null => tronTransactionFromJson(payload).sign(key).signature;

  it.each([
    ['missing expiration', { txID: 'aa'.repeat(32), raw_data: {}, signature: [], permission: null }, "'expiration'"],
    ['string expiration', { txID: 'aa'.repeat(32), raw_data: { expiration: '99999999999999' }, signature: [], permission: null }, "'>=' not supported between instances of 'int' and 'str'"],
    ['null expiration', { txID: 'aa'.repeat(32), raw_data: { expiration: null }, signature: [], permission: null }, "'>=' not supported between instances of 'int' and 'NoneType'"],
    ['null txID', { txID: null, raw_data: { expiration: future }, signature: [], permission: null }, 'txID not calculated'],
    ['integer txID', { txID: 123, raw_data: { expiration: future }, signature: [], permission: null }, 'fromhex() argument must be str, not int'],
    ['31-byte txID', { txID: 'aa'.repeat(31), raw_data: { expiration: future }, signature: [], permission: null }, 'Message hash must be 32 bytes long.'],
    ['null signature', { txID: 'aa'.repeat(32), raw_data: { expiration: future }, signature: null, permission: null }, "'NoneType' object has no attribute 'append'"],
    ['string signature', { txID: 'aa'.repeat(32), raw_data: { expiration: future }, signature: 'abc', permission: null }, "'str' object has no attribute 'append'"],
    ['permission without keys', { txID: 'aa'.repeat(32), raw_data: { expiration: future }, signature: [], permission: { x: 1 } }, "'keys'"],
  ])('%s', (_label, payload, message) => {
    expect(() => sign(payload as TronJson)).toThrow(new Error(message));
  });

  it('a key outside the permission list gives tronpy\'s BadKey text', () => {
    const permission = { keys: [{ address: `41${'00'.repeat(20)}`, weight: 1 }] };
    expect(() => sign({ txID: 'aa'.repeat(32), raw_data: { expiration: future }, signature: [], permission })).toThrow(
      new Error(
        `('provided private key is not in the permission list', 'provided ${key.publicKey.toBase58CheckAddress()}', "required {'keys': [{'address': '41${'00'.repeat(20)}', 'weight': 1}]}")`,
      ),
    );
  });

  it('payloads tronpy signs produce tronpy\'s exact signature', () => {
    expect(sign({ txID: 'aa'.repeat(32), raw_data: { expiration: future + 0.5 }, signature: [], permission: null })).toEqual([tronpySignature]);
    expect(sign({ txID: 'aa'.repeat(32), expiration: future, signature: [], permission: null })).toEqual([tronpySignature]);
  });

  it('fromJson reads the keys Python reads and fails like a KeyError when they are missing', () => {
    expect(() => TronSignedTransaction.fromJson({ type: 'TronSignedTransaction', chain_id: 1 })).toThrow(new Error("'signed_transaction'"));
    expect(() => TronSignedTransaction.fromJson({ type: 'TronSignedTransaction', chain_id: 1, signed_transaction: null })).toThrow(
      new Error("'NoneType' object is not iterable"),
    );
  });
});

describe('tronAbi encode/decode is tronpy trx_abi (eth_abi 5.2 strict + Tron addresses), from a tronpy-generated fixture', () => {
  interface AbiFixture {
    decode: Array<{ type: string; hex: string; value?: unknown; error?: string }>;
    encode: Array<{ type: string; args: unknown; hex?: string; error?: string }>;
  }
  const abi = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tronpy_abi.json'), 'utf8')) as AbiFixture;
  const untag = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(untag);
    if (value !== null && typeof value === 'object' && 'int' in value) return BigInt((value as { int: string }).int);
    if (value !== null && typeof value === 'object' && 'bytes' in value) return Buffer.from((value as { bytes: string }).bytes, 'hex');
    return value;
  };
  const normalize = (value: unknown): unknown => (value instanceof Uint8Array ? Buffer.from(value) : Array.isArray(value) ? value.map(normalize) : value);

  it.each(abi.decode.map((c) => [`${c.type} ${c.hex.slice(0, 24)}`, c] as const))('decode %s', (_label, c) => {
    if (c.error !== undefined) expect(() => tronAbiDecodeSingle(c.type, Buffer.from(c.hex, 'hex'))).toThrow(new Error(c.error));
    else expect(normalize(tronAbiDecodeSingle(c.type, Buffer.from(c.hex, 'hex')))).toEqual(normalize(untag(c.value)));
  });

  it.each(abi.encode.map((c) => [`${c.type} ${JSON.stringify(c.args).slice(0, 40)}`, c] as const))('encode %s', (_label, c) => {
    if (c.error !== undefined) expect(() => tronAbiEncodeSingle(c.type, untag(c.args))).toThrow(new Error(c.error));
    else expect(tronAbiEncodeSingle(c.type, untag(c.args))).toBe(c.hex);
  });

  it('high-s signatures recover the same key tronpy recovers (8 vectors)', () => {
    const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tronpy_high_s.json'), 'utf8')) as Array<{
      hash: string;
      sig: string;
      recovered: string;
      signer: string;
    }>;
    for (const v of vectors) {
      const signature = TronSignature.fromHex(v.sig);
      expect(signature.recoverPublicKeyFromMsgHash(Buffer.from(v.hash, 'hex')).hex()).toBe(v.recovered);
      expect(TronPublicKey.fromHex(v.signer).verifyMsgHash(Buffer.from(v.hash, 'hex'), signature)).toBe(true);
    }
  });
});

describe('lone surrogates are refused like Python str.encode, never signed as U+FFFD', () => {
  it('signMessage raises; verifySignature of the surrogate message is false', () => {
    expect(() => WALLET.signMessage('a\ud800')).toThrow(new Error("'utf-8' codec can't encode character '\\ud800' in position 1: surrogates not allowed"));
    const replacementSignature = WALLET.signMessage('a\ufffd').signature;
    expect(TronChain.verifySignature(WALLET.publicKey, 'a\ud800', new TronSignedMessage(replacementSignature))).toBe(false);
  });
});

describe('round-2 parity: Tron __str__ texts and int(s, 16)', () => {
  it('TronTransactionStatus / simulation / fees print like Python', () => {
    expect(String(TronTransactionStatus.pending(CHAIN_ID_TRON_MAINNET))).toBe(
      `TronTransactionStatus[chain_id=${CHAIN_ID_TRON_MAINNET}, status_type=Pending, inclusion_datetime_utc=None, fees=None, balance_changes=None]`,
    );
    const simulation = new TronTransactionSimulationResult({ chainId: CHAIN_ID_TRON_MAINNET, statusType: 'Failed', balanceChanges: new Map(), error: new Error('nope'), energyUsed: null });
    expect(String(simulation)).toBe(`TronTransactionSimulationResult[chain_id=${CHAIN_ID_TRON_MAINNET}, status_type=Failed, balance_changes={}, energy_used=None, error=nope]`);
  });

  it('TronAddressUtils.isHex is int(s, 16)', () => {
    expect(TronAddressUtils.isHex(' 0x_1F ')).toBe(true);
    expect(TronAddressUtils.isHex('1__f')).toBe(false);
    expect(TronAddressUtils.isHex('\u0663')).toBe(true);
  });
});

describe('round-3 parity: TronChain construction', () => {
  it.each([3448148188, 1, 56, 999999, 0, -1, -2, -1000, -3500])(
    'constructs for chain id %i like Python and leaves the network-type registry untouched',
    (chainId) => {
      const before = [networkTypeRegistrations().get(chainId), tryNetworkTypeOf(chainId)];
      const chain = new TronChain({ name: `Tron ${chainId}`, chainId, defaultRpcUrl: 'https://nile.trongrid.io', explorerUrl: 'https://nile.tronscan.org' });
      expect(chain.chainId).toBe(chainId);
      expect(chain.nativeAsset.chainId).toBe(chainId);
      expect([networkTypeRegistrations().get(chainId), tryNetworkTypeOf(chainId)]).toEqual(before);
    },
  );
});

describe('round-8 parity: constant-call replies are read like tronpy trigger_constant_contract', () => {
  const replies = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tronpy_constant_call_replies.json'), 'utf8'),
  ) as { name: string; reply: TronJson; value?: string; error?: string }[];

  it.each(replies.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const client = new TronClient({ endpointUri: 'http://127.0.0.1:9/' });
    client.makeRequest = async () => c.reply;
    const outcome = client.triggerConstSmartContractFunction(USDT_CONTRACT, USDT_CONTRACT, 'allowance(address,address)', '00');
    if (c.error === undefined) {
      await expect(outcome).resolves.toBe(c.value);
    } else {
      await expect(outcome).rejects.toThrow(c.error);
    }
  });

  it('a malformed allowance reply stops the approve flow before any broadcast, as in Python', async () => {
    for (const result of ['message', null, true] as unknown[]) {
      const broadcasts: TronJson[] = [];
      const client = new TronClient({ endpointUri: 'http://127.0.0.1:9/' });
      client.makeRequest = async (method: string, params: TronJson = {}) => {
        if (method === 'wallet/triggerconstantcontract') return { result, constant_result: ['00'.repeat(32)] };
        if (method === 'wallet/broadcasttransaction') broadcasts.push(params);
        return { result: true, txid: 'aa'.repeat(32) };
      };
      const chain = new TronChain({ name: 'Tron Stub', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'http://127.0.0.1:9/', explorerUrl: 'https://tronscan.org' });
      Object.defineProperty(chain, 'client', { get: () => client });
      const prerequisite = new TronApproveTransactionPrerequisite({
        chainId: chain.chainId,
        asset: chain.getTrc20Asset('USDC', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 6),
        walletAddress: WALLET.address,
        spenderContractAddress: USDT_CONTRACT,
        amount: 1_000n,
      });
      await expect(WALLET.handleTransactionPrerequisite(prerequisite, chain)).rejects.toBeInstanceOf(Error);
      expect(broadcasts).toEqual([]);
    }
  });
});

describe('round-8 parity: gasPricing None is rejected like Python', () => {
  it('createTransferTransaction with gasPricing null raises "Unsupported gas_pricing None"', async () => {
    const chain = new TronChain({ name: 'Tron Stub', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'http://127.0.0.1:9/', explorerUrl: 'https://tronscan.org' });
    await expect(
      chain.createTransferTransaction({
        asset: chain.nativeAsset,
        amountHr: new Decimal(1),
        senderAddress: WALLET.address,
        receiverAddress: USDT_CONTRACT,
        gasPricing: null as never,
      }),
    ).rejects.toThrow('Unsupported gas_pricing None');
  });
});

describe('round-9: caller JSON integers beyond 2^53 are refused instead of being rounded', () => {
  it('TronUnsignedTransaction.fromJson, TronSignedTransaction.fromJson and the broadcast adapter refuse them', async () => {
    const rawData = `{"contract":[{"parameter":{"value":{"amount":9007199254740993,"owner_address":"41a614f803b6fd780986a42c78ec9c7f77e6ded13c","to_address":"41a614f803b6fd780986a42c78ec9c7f77e6ded13c"},"type_url":"type.googleapis.com/protocol.TransferContract"},"type":"TransferContract"}],"ref_block_bytes":"0000","ref_block_hash":"0000000000000000","expiration":1,"timestamp":1}`;
    const transaction = `{"txID":"${'ab'.repeat(32)}","raw_data":${rawData},"signature":[]}`;
    const unsigned = `{"type":"TronUnsignedTransaction","chain_id":${CHAIN_ID_TRON_MAINNET},"unsigned_transaction":${transaction}}`;
    const signed = `{"type":"TronSignedTransaction","chain_id":${CHAIN_ID_TRON_MAINNET},"signed_transaction":${transaction}}`;
    expect(() => TronUnsignedTransaction.fromJson(unsigned)).toThrow('outside the JSON-safe integer range');
    expect(() => TronSignedTransaction.fromJson(signed)).toThrow('outside the JSON-safe integer range');
    const chain = new TronChain({ name: 'Tron Stub', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'http://127.0.0.1:9/', explorerUrl: 'https://tronscan.org' });
    await expect(chain.broadcast(transaction)).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
  });
});
