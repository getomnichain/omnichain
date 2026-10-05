import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { TronJson } from '../tron_client.ts';
import { toBase58CheckAddress } from '../tron_keys.ts';
import { encodeTronRawData, tronTransactionId } from '../tron_raw_data.ts';

interface GoldenVector {
  txID: string;
  raw_data_hex: string;
  raw_data: TronJson;
}

const vectors = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'raw_data_golden_vectors.json'), 'utf8'),
) as Record<string, GoldenVector>;

const OWNER = `41${'11'.repeat(20)}`;
const OTHER = `41${'22'.repeat(20)}`;

function rawData(type: string, value: TronJson, extra: TronJson = {}): TronJson {
  return {
    contract: [{ parameter: { value, type_url: `type.googleapis.com/protocol.${type}` }, type }],
    ref_block_bytes: 'a1b2',
    ref_block_hash: '0011223344556677',
    expiration: 1_700_000_060_000,
    timestamp: 1_700_000_000_000,
    ...extra,
  };
}

function hex(raw: TronJson): string {
  return Buffer.from(encodeTronRawData(raw)).toString('hex');
}

function refusal(raw: TronJson): string {
  try {
    encodeTronRawData(raw);
  } catch (err) {
    if (isChainError(err, ChainErrorKinds.InvalidArgument)) return err.message;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('encodeTronRawData / tronTransactionId', () => {
  it.each(Object.entries(vectors))('reproduces the mainnet bytes and txID of %s', (_name, vector) => {
    expect(hex(vector.raw_data)).toBe(vector.raw_data_hex);
    expect(tronTransactionId(vector.raw_data)).toBe(vector.txID);
  });

  it('omits proto3 defaults, so explicit zero fields give the same bytes', () => {
    const trigger = { owner_address: OWNER, contract_address: OTHER, data: 'a9059cbb' };
    expect(hex(rawData('TriggerSmartContract', { ...trigger, call_value: 0, call_token_value: 0, token_id: 0 }))).toBe(
      hex(rawData('TriggerSmartContract', trigger)),
    );
    const delegate = { owner_address: OWNER, balance: 5, receiver_address: OTHER };
    expect(hex(rawData('DelegateResourceContract', { ...delegate, resource: 'BANDWIDTH', lock: false, lock_period: 0 }))).toBe(
      hex(rawData('DelegateResourceContract', delegate)),
    );
    expect(hex(rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1 }, { fee_limit: 0, data: '' }))).toBe(
      hex(rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1 })),
    );
  });

  it('writes non-default values: call_value, lock, lock_period and the ENERGY resource by name or number', () => {
    const base = { owner_address: OWNER, contract_address: OTHER, data: 'a9059cbb' };
    expect(hex(rawData('TriggerSmartContract', { ...base, call_value: 7 }))).not.toBe(hex(rawData('TriggerSmartContract', base)));
    const delegate = { owner_address: OWNER, balance: 5, receiver_address: OTHER };
    expect(hex(rawData('DelegateResourceContract', { ...delegate, lock: true, lock_period: 3 }))).not.toBe(
      hex(rawData('DelegateResourceContract', delegate)),
    );
    const freeze = { owner_address: OWNER, frozen_balance: 10 };
    expect(hex(rawData('FreezeBalanceV2Contract', { ...freeze, resource: 'ENERGY' }))).toBe(
      hex(rawData('FreezeBalanceV2Contract', { ...freeze, resource: 1 })),
    );
  });

  it('accepts base58 and 41-hex addresses as the same bytes', () => {
    const value = { owner_address: OWNER, to_address: OTHER, amount: 1 };
    expect(hex(rawData('TransferContract', { ...value, owner_address: toBase58CheckAddress(OWNER) }))).toBe(
      hex(rawData('TransferContract', value)),
    );
  });

  it('encodes a permission id into the contract, changing the txID', () => {
    const value = { owner_address: OWNER, to_address: OTHER, amount: 1 };
    const plain = rawData('TransferContract', value);
    const withPermission = rawData('TransferContract', value);
    (withPermission.contract as TronJson[])[0].Permission_id = 2;
    expect(tronTransactionId(withPermission)).not.toBe(tronTransactionId(plain));
    expect(hex(withPermission)).toContain('2802');
  });

  it.each([
    ['an unsupported contract type', rawData('TransferAssetContract', { owner_address: OWNER }), 'contract type TransferAssetContract is not supported'],
    ['two contracts', { ...rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1 }), contract: [{}, {}] }, 'raw_data.contract must hold exactly one contract'],
    ['a TRC-10 call_token_value', rawData('TriggerSmartContract', { owner_address: OWNER, contract_address: OTHER, data: '', call_token_value: 1 }), 'TriggerSmartContract.call_token_value must be 0'],
    ['a TRC-10 token_id', rawData('TriggerSmartContract', { owner_address: OWNER, contract_address: OTHER, data: '', token_id: 1000001 }), 'TriggerSmartContract.token_id must be 0'],
    ['an unknown raw_data field', rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1 }, { auths: [{}] }), 'raw_data has fields that cannot be serialized locally: auths'],
    ['an unknown contract value field', rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1, extra: 1 }), 'TransferContract value has fields that cannot be serialized locally: extra'],
    ['a mismatched type_url', { ...rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1 }), contract: [{ type: 'TransferContract', parameter: { value: { owner_address: OWNER }, type_url: 'type.googleapis.com/protocol.Other' } }] }, 'type_url must be type.googleapis.com/protocol.TransferContract'],
    ['a negative amount', rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: -1 }), 'TransferContract.amount must be a non-negative integer'],
    ['a fractional amount', rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1.5 }), 'TransferContract.amount must be a non-negative integer'],
    ['an amount beyond 2^53', rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 2 ** 53 }), 'TransferContract.amount must be a non-negative integer'],
    ['a string expiration', rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1 }, { expiration: '1' }), 'raw_data.expiration must be a non-negative integer'],
    ['odd-length calldata', rawData('TriggerSmartContract', { owner_address: OWNER, contract_address: OTHER, data: 'abc' }), 'TriggerSmartContract.data must be an even-length hex string'],
    ['a non-Tron address', rawData('TransferContract', { owner_address: `00${'11'.repeat(20)}`, to_address: OTHER, amount: 1 }), 'TransferContract.owner_address is not a Tron address'],
    ['an unknown resource', rawData('FreezeBalanceV2Contract', { owner_address: OWNER, frozen_balance: 1, resource: 'WATER' }), 'FreezeBalanceV2Contract.resource must be one of BANDWIDTH, ENERGY, TRON_POWER'],
    ['a non-boolean lock', rawData('DelegateResourceContract', { owner_address: OWNER, balance: 1, receiver_address: OTHER, lock: 1 }), 'DelegateResourceContract.lock must be a boolean'],
  ])('refuses %s', (_label, raw, message) => {
    const text = refusal(raw);
    expect(text.startsWith('Tron raw_data cannot be serialized locally: ')).toBe(true);
    expect(text).toContain(message);
  });

  it('accepts amounts given as bigint', () => {
    expect(hex(rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1n }))).toBe(
      hex(rawData('TransferContract', { owner_address: OWNER, to_address: OTHER, amount: 1 })),
    );
  });
});
