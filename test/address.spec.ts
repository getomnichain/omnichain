import { validateSync } from 'class-validator';

import { NetworkType, registerNonEvmChain } from '../network_type.ts';

import { EvmAddress } from '../evm/evm_address.ts';
import { TonAddress } from '../ton/ton_address.ts';

import { addressFor, canonicalizeAddress } from '../address.factory.ts';
import { IsAddress } from '../is_address.decorator.ts';

const EVM_CHAIN_ID = 1;
const TON_CHAIN_ID = -239;

const VALID_EVM_CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const VALID_EVM_LOWER = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const VALID_TON_RAW =
  '-1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

beforeAll(() => {
  registerNonEvmChain(TON_CHAIN_ID, NetworkType.TON);
});

describe('addressFor', () => {
  it('dispatches to EvmAddress for EVM-mapped chainIds', () => {
    expect(addressFor(EVM_CHAIN_ID, VALID_EVM_LOWER)).toBeInstanceOf(EvmAddress);
  });

  it('dispatches to TonAddress for chainIds registered as TON', () => {
    expect(addressFor(TON_CHAIN_ID, VALID_TON_RAW)).toBeInstanceOf(TonAddress);
  });

  it('falls back to EVM when chainId is unregistered', () => {
    expect(addressFor(424242, VALID_EVM_LOWER)).toBeInstanceOf(EvmAddress);
  });
});

describe('canonicalizeAddress', () => {
  it('lowercases an EVM address', () => {
    expect(canonicalizeAddress(EVM_CHAIN_ID, VALID_EVM_CHECKSUM)).toBe(VALID_EVM_LOWER);
  });

  it('preserves a TON address verbatim', () => {
    expect(canonicalizeAddress(TON_CHAIN_ID, VALID_TON_RAW)).toBe(VALID_TON_RAW);
  });

  it('throws on an invalid address', () => {
    expect(() => canonicalizeAddress(EVM_CHAIN_ID, 'not-an-address')).toThrow();
  });
});

class DtoUnderTest {
  chainId!: number;

  @IsAddress('chainId')
  token!: string;
}

function makeDto(chainId: number, token: string): DtoUnderTest {
  const dto = new DtoUnderTest();
  dto.chainId = chainId;
  dto.token = token;
  return dto;
}

describe('@IsAddress', () => {
  it('accepts a valid EVM address when the referenced chainId is EVM', () => {
    expect(validateSync(makeDto(EVM_CHAIN_ID, VALID_EVM_LOWER))).toHaveLength(0);
  });

  it('rejects an invalid EVM address when the referenced chainId is EVM', () => {
    const errors = validateSync(makeDto(EVM_CHAIN_ID, '0xZZZZ'));
    expect(errors.find((error) => error.property === 'token')).toBeDefined();
  });

  it('accepts a valid TON address when the referenced chainId is TON', () => {
    expect(validateSync(makeDto(TON_CHAIN_ID, VALID_TON_RAW))).toHaveLength(0);
  });

  it('rejects an EVM-shaped value when the referenced chainId is TON', () => {
    const errors = validateSync(makeDto(TON_CHAIN_ID, VALID_EVM_LOWER));
    expect(errors.find((error) => error.property === 'token')).toBeDefined();
  });
});
