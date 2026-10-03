import { readFileSync } from 'node:fs';
import { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

import { AbiCoder, keccak256, toUtf8Bytes } from 'ethers';

import { FiatCurrency } from '../../chain_type.ts';
import { CHAIN_ID_TRON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { TronAsset } from '../tron_asset.ts';
import { TRON_MAINNET_STABLECOINS_PEG, TRON_TRX } from '../tron_assets.ts';
import { TronChain, TronSignedMessage } from '../tron_chain.ts';
import { TRONPY_USER_AGENT, TronClient, TronJson, TronTvmError } from '../tron_client.ts';
import { TronContract } from '../tron_contract.ts';
import { TronPrivateKey } from '../tron_keys.ts';
import { TronHandledApprovePrerequisiteResponse } from '../tron_transactions.ts';
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
  close: () => Promise<void>;
}

async function startNode(): Promise<TronNodeStub> {
  const stub = { requests: [] as RecordedRequest[], routes: {} as Record<string, (body: TronJson) => TronJson> };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/trongrid/, '');
      const body = raw === '' ? {} : (JSON.parse(raw) as TronJson);
      stub.requests.push({ path, headers: req.headers, body });
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

  it('keeps the node code for classification: TOO_BIG is TransactionTooLarge, the rest BroadcastRejected', () => {
    expect(() => client.handleApiError(payloads.too_big)).toThrow(expect.objectContaining({ kind: ChainErrorKinds.TransactionTooLarge }));
    expect(() => client.handleApiError(payloads.dup)).toThrow(
      expect.objectContaining({ kind: ChainErrorKinds.BroadcastRejected, code: 'DUP_TRANSACTION_ERROR' }),
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
      expect(inspect(value, { depth: 10, showHidden: true })).not.toContain(secret);
    }
    expect(JSON.stringify(chain)).not.toContain('api-key-must-not-leak');
    expect(inspect(chain, { depth: 10, showHidden: true })).not.toContain('api-key-must-not-leak');
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
