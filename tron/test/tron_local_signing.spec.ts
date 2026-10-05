import { jest } from '@jest/globals';
import { Decimal } from 'decimal.js';

import { CHAIN_ID_TRON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { tronSha256 } from '../tron_base58.ts';
import { TronChain } from '../tron_chain.ts';
import { TronClient, TronJson } from '../tron_client.ts';
import { TronPrivateKey, TronSignature, bytesToHex, hexToBytes, toHexAddress } from '../tron_keys.ts';
import { encodeTronRawData, tronTransactionId } from '../tron_raw_data.ts';
import { TronTransaction } from '../tron_transaction_builder.ts';
import { TronSignedTransaction, TronUnsignedTransaction } from '../tron_transactions.ts';
import { TronWallet } from '../tron_wallet.ts';

const BLOCK_ID = '0000000004a3b2c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5';
const KEY = new TronPrivateKey(new Uint8Array(32).fill(7));
const OWNER = KEY.publicKey.toBase58CheckAddress();
const OTHER = 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

function stubChain(getSignWeight?: (params: TronJson) => TronJson): { chain: TronChain; methods: string[] } {
  const methods: string[] = [];
  const chain = new TronChain({ name: 'Tron Stub', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'https://api.trongrid.io', explorerUrl: 'https://tronscan.org' });
  const client = new TronClient({ endpointUri: 'https://api.trongrid.io' });
  client.makeRequest = async (method: string, params: TronJson = {}) => {
    methods.push(method);
    if (method === 'wallet/getnodeinfo') return { solidityBlock: `Num:77775553,ID:${BLOCK_ID}` };
    if (method === 'wallet/getsignweight' && getSignWeight) return getSignWeight(params);
    if (method === 'wallet/getcontract') return { contract_address: params.value };
    throw new Error(`unexpected call ${method}`);
  };
  Object.defineProperty(chain, 'client', { get: () => client });
  return { chain, methods };
}

function signerOf(transaction: TronTransaction): string {
  const signature = TronSignature.fromHex((transaction.signature as string[])[0]);
  return signature.recoverPublicKeyFromMsgHash(hexToBytes(transaction.txid)).toBase58CheckAddress();
}

describe('Tron transactions are built and signed locally', () => {
  it.each([
    ['TransferContract with a memo', (chain: TronChain) => chain.trx.transfer(OWNER, OTHER, 1_500_000).memo('intent-42')],
    [
      'a generic TriggerSmartContract with call_value, fee_limit and memo',
      (chain: TronChain) =>
        chain.trx
          .buildTransaction('TriggerSmartContract', {
            owner_address: toHexAddress(OWNER),
            contract_address: toHexAddress(USDT),
            data: `a9059cbb${'00'.repeat(64)}`,
            call_value: 3,
          })
          .feeLimit(10_000_000)
          .memo('20-25 号'),
    ],
    [
      'FreezeBalanceV2Contract for ENERGY',
      (chain: TronChain) =>
        chain.trx.buildTransaction('FreezeBalanceV2Contract', { owner_address: toHexAddress(OWNER), frozen_balance: 1_000_000, resource: 'ENERGY' }),
    ],
    [
      'DelegateResourceContract with default resource and lock',
      (chain: TronChain) =>
        chain.trx.buildTransaction('DelegateResourceContract', {
          owner_address: toHexAddress(OWNER),
          receiver_address: toHexAddress(OTHER),
          balance: 217_000_000,
          resource: 'BANDWIDTH',
          lock: false,
          lock_period: 0,
        }),
    ],
  ])('%s: one node call, local txID, signature by the owner', async (_label, build) => {
    const { chain, methods } = stubChain();

    const transaction = await build(chain).build();
    transaction.sign(KEY);

    expect(methods).toEqual(['wallet/getnodeinfo']);
    expect(transaction.txid).toBe(tronTransactionId(transaction.rawData));
    expect(transaction.txid).toBe(bytesToHex(tronSha256(hexToBytes(transaction.rawDataHex))));
    expect(signerOf(transaction)).toBe(OWNER);
  });

  it('omits the default resource and lock of DelegateResourceContract from the signed bytes', async () => {
    const { chain } = stubChain();
    const explicit = await chain.trx
      .buildTransaction('DelegateResourceContract', {
        owner_address: toHexAddress(OWNER),
        receiver_address: toHexAddress(OTHER),
        balance: 1,
        resource: 'BANDWIDTH',
        lock: false,
      })
      .build();
    const implicitRaw = JSON.parse(JSON.stringify(explicit.rawData)) as TronJson;
    const value = ((implicitRaw.contract as TronJson[])[0].parameter as TronJson).value as TronJson;
    delete value.resource;
    delete value.lock;

    expect(explicit.rawDataHex).toBe(bytesToHex(encodeTronRawData(implicitRaw)));
  });

  it('createTransferTransaction and TronWallet.signTransaction go through the local path', async () => {
    const wallet = TronWallet.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    const { chain, methods } = stubChain();

    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1'),
      senderAddress: wallet.address,
      receiverAddress: OTHER,
      memo: 'hi',
    });
    const signed = await wallet.signTransaction(transaction, chain);

    expect(methods).toEqual(['wallet/getnodeinfo']);
    expect(signed.txHash).toBe(tronTransactionId(transaction.transaction.rawData));
    expect(signerOf(signed.signedTransaction)).toBe(wallet.address);
  });

  it('refuses to sign after raw_data was changed under its txID, without using the key', async () => {
    const wallet = TronWallet.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    const { chain } = stubChain();
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1'),
      senderAddress: wallet.address,
      receiverAddress: OTHER,
    });
    const tampered = TronUnsignedTransaction.fromJson(transaction.toJson());
    ((((tampered.transaction.rawData.contract as TronJson[])[0].parameter as TronJson).value as TronJson).amount as number) = 999_000_000;
    const spy = jest.spyOn(TronPrivateKey.prototype, 'signMsgHash');
    try {
      await expect(wallet.signTransaction(tampered, chain)).rejects.toMatchObject({
        kind: ChainErrorKinds.InvalidArgument,
        message: expect.stringContaining('refusing to sign'),
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('an unsigned transaction survives a JSON round trip and still signs', async () => {
    const wallet = TronWallet.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    const { chain } = stubChain();
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1'),
      senderAddress: wallet.address,
      receiverAddress: OTHER,
    });

    const signed = await wallet.signTransaction(TronUnsignedTransaction.fromJson(transaction.toJson()), chain);

    expect(signed.txHash).toBe(transaction.txId);
  });

  it('with a permission id, a getsignweight txID that differs from the local one is refused', async () => {
    const { chain } = stubChain(() => ({ transaction: { transaction: { txID: 'ee'.repeat(32) } }, permission: { keys: [] } }));

    await expect(chain.trx.transfer(OWNER, OTHER, 1).permissionId(2).build()).rejects.toMatchObject({
      kind: ChainErrorKinds.InvalidArgument,
      message: expect.stringContaining(`wallet/getsignweight returned txID ${'ee'.repeat(32)}`),
    });
  });
});

describe('re-broadcasting a stored signed transaction', () => {
  const wallet = TronWallet.fromMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');

  function broadcastingChain(): { chain: TronChain; broadcasts: TronJson[] } {
    const broadcasts: TronJson[] = [];
    const { chain } = stubChain();
    const client = chain.client;
    const base = client.makeRequest.bind(client);
    client.makeRequest = async (method: string, params: TronJson = {}) => {
      if (method !== 'wallet/broadcasttransaction') return base(method, params);
      broadcasts.push(JSON.parse(JSON.stringify(params)) as TronJson);
      return { result: true, txid: params.txID };
    };
    return { chain, broadcasts };
  }

  async function storedSignedTransaction(chain: TronChain): Promise<{ signed: TronSignedTransaction; stored: string }> {
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1'),
      senderAddress: wallet.address,
      receiverAddress: OTHER,
      memo: 'intent-42',
    });
    const signed = await wallet.signTransaction(transaction, chain);
    return { signed, stored: signed.toJsonStr() };
  }

  it('a stored transaction loaded back is sent byte-for-byte as the original, with the same txID', async () => {
    const { chain, broadcasts } = broadcastingChain();
    const { signed, stored } = await storedSignedTransaction(chain);

    const first = await chain.broadcast(stored);
    const second = await chain.broadcastSignedTransaction(TronSignedTransaction.fromJson(stored));

    expect(first).toBe(signed.txHash);
    expect(second.txHash).toBe(signed.txHash);
    expect(second.broadcastError).toBeNull();
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[0]).toEqual(JSON.parse(JSON.stringify(signed.signedTransaction.toJson())));
    expect(broadcasts[1]).toEqual(broadcasts[0]);
  });

  it.each([
    ['its raw_data changed', (json: TronJson) => {
      ((((json.raw_data as TronJson).contract as TronJson[])[0].parameter as TronJson).value as TronJson).amount = 999_000_000;
    }],
    ['its txID changed', (json: TronJson) => {
      json.txID = 'ee'.repeat(32);
    }],
  ])('a stored transaction with %s is refused before it reaches the node', async (_label, tamper) => {
    const { chain, broadcasts } = broadcastingChain();
    const { stored } = await storedSignedTransaction(chain);
    const parsed = JSON.parse(stored) as TronJson;
    tamper(parsed.signed_transaction as TronJson);
    const tampered = JSON.stringify(parsed);

    await expect(chain.broadcast(tampered)).rejects.toMatchObject({
      kind: ChainErrorKinds.InvalidArgument,
      message: expect.stringContaining('refusing to broadcast'),
    });
    const response = await chain.broadcastSignedTransaction(TronSignedTransaction.fromJson(tampered));

    expect(response.broadcastError).toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
    expect(broadcasts).toEqual([]);
  });
});
