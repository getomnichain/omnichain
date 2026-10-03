import {
  TronContractType,
  TronResourceCode,
  parseTronCanonicalTransaction,
} from '../tron_canonical_transaction.ts';

const OWNER = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
const OTHER = '41c6e1a1b2c3d4e5f60718293a4b5c6d7e8f901a2b';

function envelope(type: TronContractType, value: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    txID: 'ab'.repeat(32),
    raw_data: {
      contract: [{ parameter: { value, type_url: `type.googleapis.com/protocol.${type}` }, type }],
      ref_block_bytes: '1a2b',
      ref_block_hash: '0102030405060708',
      expiration: 1_800_000_060_000,
      timestamp: 1_800_000_000_000,
      ...extra,
    },
    signature: [],
  };
}

const permission = {
  type: 2,
  id: 2,
  permission_name: 'active',
  threshold: 2,
  operations: '7fff1fc0033e0100000000000000000000000000000000000000000000000000',
  keys: [
    { address: OWNER, weight: 1 },
    { address: OTHER, weight: 1 },
  ],
};

const SAMPLES: Array<[TronContractType, Record<string, unknown>]> = [
  [TronContractType.TransferContract, { owner_address: OWNER, to_address: OTHER, amount: 1_000_000 }],
  [TronContractType.TransferAssetContract, { owner_address: OWNER, to_address: OTHER, asset_name: '31303030303031', amount: 5 }],
  [TronContractType.TriggerSmartContract, { owner_address: OWNER, contract_address: OTHER, data: 'a9059cbb', call_value: 0 }],
  [TronContractType.CreateSmartContract, { owner_address: OWNER, new_contract: { bytecode: '6080', name: 'X' } }],
  [TronContractType.FreezeBalanceV2Contract, { owner_address: OWNER, frozen_balance: 10_000_000, resource: 'ENERGY' }],
  [TronContractType.UnfreezeBalanceV2Contract, { owner_address: OWNER, unfreeze_balance: 10_000_000, resource: 'BANDWIDTH' }],
  [TronContractType.DelegateResourceContract, { owner_address: OWNER, receiver_address: OTHER, balance: 1, resource: 'ENERGY', lock: true, lock_period: 86400 }],
  [TronContractType.UnDelegateResourceContract, { owner_address: OWNER, receiver_address: OTHER, balance: 1, resource: 'ENERGY' }],
  [TronContractType.VoteWitnessContract, { owner_address: OWNER, votes: [{ vote_address: OTHER, vote_count: 3 }] }],
  [TronContractType.WithdrawBalanceContract, { owner_address: OWNER }],
  [TronContractType.AccountUpdateContract, { owner_address: OWNER, account_name: '6e616d65' }],
  [TronContractType.AccountPermissionUpdateContract, { owner_address: OWNER, owner: { ...permission, type: 0, id: 0, permission_name: 'owner' }, actives: [permission] }],
];

describe('TronCanonicalTransaction (port of impl/tron/helpers/transaction.py)', () => {
  it.each(SAMPLES)('parses a %s entry through the discriminated union', (type, value) => {
    const parsed = parseTronCanonicalTransaction(envelope(type, value));
    const entry = parsed.raw_data.contract[0];
    expect(entry.type).toBe(type);
    expect(entry.parameter.type_url).toBe(`type.googleapis.com/protocol.${type}`);
    expect(entry.parameter.value.owner_address).toBe(OWNER);
    expect(parsed.tx_id).toBe('ab'.repeat(32));
    expect(parsed.signature).toEqual([]);
  });

  it('fills optional fields with null like pydantic defaults and keeps unknown fields', () => {
    const parsed = parseTronCanonicalTransaction(
      envelope(TronContractType.TriggerSmartContract, { owner_address: OWNER, contract_address: OTHER, data: 'ff', future_field: 1 }, { future_raw: 'x' }),
    );
    const value = parsed.raw_data.contract[0].parameter.value as Record<string, unknown>;
    expect(value).toMatchObject({ call_value: null, call_token_value: null, token_id: null, future_field: 1 });
    expect(parsed.raw_data).toMatchObject({ data: null, fee_limit: null, ref_block_num: null, scripts: null, auths: null, future_raw: 'x' });
    expect(parsed).toMatchObject({ raw_data_hex: null, permission: null, ret: null, visible: null });
  });

  it('coerces numeric strings like pydantic lax mode and validates nested permissions', () => {
    const parsed = parseTronCanonicalTransaction({
      ...envelope(TronContractType.TransferContract, { owner_address: OWNER, to_address: OTHER, amount: '42' }),
      permission,
      signature: ['00'.repeat(65)],
    });
    expect(parsed.raw_data.contract[0].parameter.value.amount).toBe(42);
    expect(parsed.permission?.keys).toHaveLength(2);
    expect(parsed.signature).toEqual(['00'.repeat(65)]);
    const update = parseTronCanonicalTransaction(envelope(TronContractType.AccountPermissionUpdateContract, SAMPLES[11][1]));
    const value = update.raw_data.contract[0].parameter.value as { actives: Array<{ threshold: number }>; witness: unknown };
    expect(value.actives[0].threshold).toBe(2);
    expect(value.witness).toBeNull();
  });

  it('rejects missing required fields, bad enums, unknown contract types and missing txID', () => {
    expect(() => parseTronCanonicalTransaction(envelope(TronContractType.TransferContract, { owner_address: OWNER, to_address: OTHER }))).toThrow(
      /raw_data\.contract\[0\]\.parameter\.value\.amount: field required/,
    );
    expect(() =>
      parseTronCanonicalTransaction(envelope(TronContractType.FreezeBalanceV2Contract, { owner_address: OWNER, frozen_balance: 1, resource: 'POWER' })),
    ).toThrow(/expected one of BANDWIDTH, ENERGY/);
    expect(() => parseTronCanonicalTransaction(envelope('ShieldedTransferContract' as TronContractType, { owner_address: OWNER }))).toThrow(
      /unsupported contract type/,
    );
    const { txID: _drop, ...noId } = envelope(TronContractType.WithdrawBalanceContract, { owner_address: OWNER });
    void _drop;
    expect(() => parseTronCanonicalTransaction(noId)).toThrow(/txID: field required/);
    expect(() =>
      parseTronCanonicalTransaction({ ...envelope(TronContractType.WithdrawBalanceContract, { owner_address: OWNER }), permission: { ...permission, type: 'Active' } }),
    ).toThrow(/permission\.type: expected an integer/);
  });

  it('exposes the resource enum values used on the wire', () => {
    expect(Object.values(TronResourceCode)).toEqual(['BANDWIDTH', 'ENERGY']);
    expect(Object.values(TronContractType)).toHaveLength(12);
  });
});
