import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAIN_ID_TRON_MAINNET } from '../../chain_ids.ts';
import { TransactionStatusTypes } from '../../transaction_status.ts';
import { TRON_USDT } from '../tron_assets.ts';
import { TRC20_TRANSFER_TOPIC, TronChain } from '../tron_chain.ts';
import { TronClient, TronJson } from '../tron_client.ts';
import { toBase58CheckAddress, toHexAddress } from '../tron_keys.ts';
import { TronTransactionStatus } from '../tron_transaction_status.ts';

const recordings = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mainnet_status_recordings.json'), 'utf8'),
) as Record<string, TronJson>;

const TXID = 'ab'.repeat(32);
const OWNER = toBase58CheckAddress(`41${'aa'.repeat(20)}`);
const CONTRACT = toBase58CheckAddress(`41${'bb'.repeat(20)}`);
const USER = toBase58CheckAddress(`41${'cc'.repeat(20)}`);
const SELF_DESTRUCTED_HEX = `41${'dd'.repeat(20)}`;
const NFT = toBase58CheckAddress(`41${'ee'.repeat(20)}`);
const MEMO = 'intent-42 号';
const word = (hex: string): string => hex.padStart(64, '0');
const noteHex = (note: string): string => Buffer.from(note, 'utf8').toString('hex');
const tvmHex = (base58: string): string => toHexAddress(base58);

interface StubOptions {
  info?: TronJson;
  transaction?: TronJson;
}

function stubChain(options: StubOptions = {}): { chain: TronChain; methods: string[] } {
  const methods: string[] = [];
  const chain = new TronChain({
    name: 'Tron Stub',
    chainId: CHAIN_ID_TRON_MAINNET,
    defaultRpcUrl: 'https://api.trongrid.io',
    explorerUrl: 'https://tronscan.org',
  });
  const client = new TronClient({ endpointUri: 'https://api.trongrid.io' });
  client.makeRequest = async (method: string, params: TronJson = {}) => {
    methods.push(method);
    if (method === 'wallet/gettransactioninfobyid') return options.info ?? successfulInfo();
    if (method === 'wallet/gettransactionbyid') return options.transaction ?? contractCall();
    if (method === 'wallet/getchainparameters') return { chainParameter: [{ key: 'getEnergyFee', value: 100 }] };
    const recorded = recordings[`${method} ${JSON.stringify(params)}`];
    if (recorded !== undefined) return recorded;
    throw new Error(`unexpected call ${method}`);
  };
  Object.defineProperty(chain, 'client', { get: () => client });
  return { chain, methods };
}

function replayChain(): TronChain {
  const chain = new TronChain({ name: 'Tron Replay', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'https://api.trongrid.io', explorerUrl: 'https://tronscan.org' });
  const client = new TronClient({ endpointUri: 'https://api.trongrid.io' });
  client.makeRequest = async (method: string, params: TronJson = {}) => {
    const recorded = recordings[`${method} ${JSON.stringify(params)}`];
    if (recorded === undefined) throw new Error(`not recorded: ${method}`);
    return recorded;
  };
  Object.defineProperty(chain, 'client', { get: () => client });
  return chain;
}

function successfulInfo(overrides: TronJson = {}): TronJson {
  return {
    id: TXID,
    blockNumber: 77_775_570,
    blockTimeStamp: 1_700_000_000_000,
    fee: 0,
    receipt: { result: 'SUCCESS' },
    internal_transactions: [
      { caller_address: CONTRACT, transferTo_address: USER, callValueInfo: [{ callValue: 7_000_000 }], note: noteHex('call'), rejected: true },
      { caller_address: CONTRACT, transferTo_address: USER, callValueInfo: [{ callValue: 9_000_000 }], note: noteHex('delegateResourceOfEnergy') },
      { caller_address: CONTRACT, transferTo_address: USER, callValueInfo: [{ callValue: 3, tokenId: '1002000' }], note: noteHex('call') },
      {
        caller_address: CONTRACT,
        transferTo_address: USER,
        callValueInfo: [{ callValue: 1_000_000 }, { callValue: 2_000_000 }, { callValue: 5, tokenId: '1002000' }],
        note: noteHex('call'),
      },
      { caller_address: SELF_DESTRUCTED_HEX, transferTo_address: USER, callValueInfo: [{ callValue: 500_000 }], note: noteHex('suicide') },
      { caller_address: CONTRACT, transferTo_address: USER, callValueInfo: [{}], note: noteHex('call') },
    ],
    log: [
      { address: TRON_USDT.contractAddress, topics: [TRC20_TRANSFER_TOPIC, word(tvmHex(OWNER).slice(2)), word(tvmHex(USER).slice(2))], data: word((748_000_000).toString(16)) },
      { address: NFT, topics: [TRC20_TRANSFER_TOPIC, word(tvmHex(OWNER).slice(2)), word(tvmHex(USER).slice(2)), word('1')], data: '' },
      { address: NFT, topics: [TRC20_TRANSFER_TOPIC, word(tvmHex(OWNER).slice(2)), word(tvmHex(USER).slice(2)), word('1')], data: word('5') },
      { address: NFT, topics: [TRC20_TRANSFER_TOPIC, word(tvmHex(OWNER).slice(2)), word(tvmHex(USER).slice(2))], data: `${word('5')}${word('6')}` },
      { address: NFT, topics: [TRC20_TRANSFER_TOPIC, word(tvmHex(OWNER).slice(2)), word(tvmHex(USER).slice(2))], data: 'zz'.repeat(32) },
    ],
    ...overrides,
  };
}

function contractCall(memoHex: string | null = Buffer.from(MEMO, 'utf8').toString('hex').toUpperCase()): TronJson {
  return {
    txID: TXID,
    raw_data: {
      contract: [
        {
          parameter: {
            value: { owner_address: OWNER, contract_address: CONTRACT, call_value: 5_000_000, data: 'a9059cbb' },
            type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
          },
          type: 'TriggerSmartContract',
        },
      ],
      ...(memoHex === null ? {} : { data: memoHex }),
    },
  };
}

function change(status: TronTransactionStatus, wallet: string, contract: string | null): string | null {
  const perWallet = status.balanceChanges?.get(wallet);
  if (!perWallet) return null;
  for (const { token, change: value } of perWallet.values()) {
    if (((token as { contractAddress?: string | null }).contractAddress ?? null) === contract) return value.balanceChangeHr.toString();
  }
  return null;
}

describe('TronTransactionStatus block number, signers and memo', () => {
  it('a successful status carries the block number, the owner as signer and the decoded memo', async () => {
    const { chain } = stubChain();

    const status = await chain.getTransactionStatus(TXID);

    expect(status.status).toBe(TransactionStatusTypes.Success);
    expect(status.blockNumber).toBe(77_775_570);
    expect(status.signers).toEqual([OWNER]);
    expect(status.memo).toBe(MEMO);
    expect(status.memoHex).toBe(Buffer.from(MEMO, 'utf8').toString('hex'));
  });

  it('a failed status carries them too and keeps balanceChanges null', async () => {
    const { chain } = stubChain({ info: successfulInfo({ receipt: { result: 'REVERT' } }) });

    const status = await chain.getTransactionStatus(TXID);

    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.balanceChanges).toBeNull();
    expect([status.blockNumber, status.signers, status.memo]).toEqual([77_775_570, [OWNER], MEMO]);
  });

  it('a memo that is not UTF-8 is visible as hex only; no memo gives nulls', async () => {
    const notText = await stubChain({ transaction: contractCall('c328') }).chain.getTransactionStatus(TXID);
    expect([notText.memo, notText.memoHex]).toEqual([null, 'c328']);

    const none = await stubChain({ transaction: contractCall(null) }).chain.getTransactionStatus(TXID);
    expect([none.memo, none.memoHex]).toEqual([null, null]);
  });

  it('without the raw transaction, signers is empty and the memo is null', async () => {
    const { chain } = stubChain({ transaction: {} });

    const status = await chain.getTransactionStatus(TXID);

    expect(status.signers).toEqual([]);
    expect([status.memo, status.memoHex]).toEqual([null, null]);
    expect(status.blockNumber).toBe(77_775_570);
    expect(change(status, OWNER, null)).toBeNull();
  });

  it('pending and not-found statuses carry the defaults', async () => {
    const pending = await stubChain({ info: { blockNumber: 1 } }).chain.getTransactionStatus(TXID);
    const notFound = await stubChain({ info: {} }).chain.getTransactionStatus(TXID);

    for (const status of [pending, notFound]) {
      expect([status.blockNumber, status.signers, status.memo, status.memoHex]).toEqual([null, [], null, null]);
    }
    expect([pending.status, notFound.status]).toEqual([TransactionStatusTypes.Pending, TransactionStatusTypes.NotFound]);
  });

  it('mainnet replays: a TRX transfer and a reverted contract call', async () => {
    const chain = replayChain();

    const transfer = await chain.getTransactionStatus('bb565717e908ac084c0471e2d608aae0ed1913c2dd9ef11c500193fbb6eb22d2');
    const reverted = await chain.getTransactionStatus('3c3ec32161ccb4ba417d33729ab218796f9a1a8f5af1a12266736ef39dc2d24a');

    expect([transfer.blockNumber, transfer.signers, transfer.memo]).toEqual([81_902_136, ['TAQ3S3o1LnHGo8yKob57zYfv64yz6L5UfY'], null]);
    expect(reverted.status).toBe(TransactionStatusTypes.Failed);
    expect([reverted.blockNumber, reverted.signers]).toEqual([83_295_537, ['TBeSjFtNPLqhou3ooxmcmFuTbBnaFHh5da']]);
  });
});

describe('TronChain balance changes count only real money moves', () => {
  it('skips rejected, staking/delegation, TRC-10 and zero entries; sums TRX entries; adds call_value; ignores NFT-style logs', async () => {
    const { chain } = stubChain();

    const status = await chain.getTransactionStatus(TXID);

    expect(change(status, OWNER, null)).toBe('-5');
    expect(change(status, CONTRACT, null)).toBe('2');
    expect(change(status, USER, null)).toBe('3.5');
    expect(change(status, toBase58CheckAddress(SELF_DESTRUCTED_HEX), null)).toBe('-0.5');
    expect(change(status, OWNER, TRON_USDT.contractAddress)).toBe('-748');
    expect(change(status, USER, TRON_USDT.contractAddress)).toBe('748');
    expect(change(status, USER, NFT)).toBeNull();
    expect(change(status, OWNER, NFT)).toBeNull();
  });

  it('a contract call without call_value moves no TRX from its owner', async () => {
    const transaction = contractCall();
    ((((transaction.raw_data as TronJson).contract as TronJson[])[0].parameter as TronJson).value as TronJson).call_value = 0;

    const status = await stubChain({ transaction, info: successfulInfo({ internal_transactions: [], log: [] }) }).chain.getTransactionStatus(TXID);

    expect(change(status, OWNER, null)).toBeNull();
    expect(change(status, CONTRACT, null)).toBeNull();
  });
});

describe('TronChain status adds no node calls', () => {
  it('reads one transaction with gettransactioninfobyid and gettransactionbyid, plus chain parameters once per chain', async () => {
    const { chain, methods } = stubChain({ info: successfulInfo({ log: [] }) });

    await chain.getTransactionStatus(TXID);
    await chain.getTransactionStatus(TXID);

    expect(methods).toEqual([
      'wallet/gettransactioninfobyid',
      'wallet/gettransactionbyid',
      'wallet/getchainparameters',
      'wallet/gettransactioninfobyid',
      'wallet/gettransactionbyid',
    ]);
  });
});
