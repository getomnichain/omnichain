import { validateSync } from 'class-validator';

import { NetworkType, registerNonEvmChain } from '../network_type.ts';

import { EvmAddress } from '../evm/evm_address.ts';
import { SolanaAddress } from '../solana/solana_address.ts';
import { TonAddress } from '../ton/ton_address.ts';
// Solana chainIds are statically seeded as NetworkType.SOLANA in
// network_type.ts (from CHAIN_FAMILY_SOLANA), independent of any import of
// SolanaChain instances — so addressFor/canonicalizeAddress route them
// correctly whether or not any concrete SolanaChain constructor has run.
import {
  CHAIN_ID_SOLANA_DEVNET as SOLANA_DEVNET_CHAIN_ID,
  CHAIN_ID_SOLANA_MAINNET as SOLANA_MAINNET_CHAIN_ID,
  CHAIN_ID_SOLANA_TESTNET as SOLANA_TESTNET_CHAIN_ID,
} from '../chain_ids.ts';

import { addressFor, canonicalizeAddress, tryCanonicalizeAddress } from '../address.factory.ts';
import { IsAddress } from '../is_address.decorator.ts';

const EVM_CHAIN_ID = 1;
const TON_CHAIN_ID = -239;

const VALID_EVM_CHECKSUM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const VALID_EVM_LOWER = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const VALID_TON_RAW =
  '-1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
// wrapped SOL mint — a 32-byte base58 key (case-sensitive, never lowercased).
const VALID_SOLANA = 'So11111111111111111111111111111111111111112';

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

  it('positive unregistered chainId defaults to EvmAddress (EIP-155)', () => {
    expect(addressFor(424242, VALID_EVM_LOWER)).toBeInstanceOf(EvmAddress);
  });

  it('negative unregistered chainId throws ChainError(ChainNotSupported)', () => {
    expect(() => addressFor(-999999, VALID_EVM_LOWER)).toThrow(/Unregistered non-EVM chainId/);
  });

  it('dispatches to SolanaAddress for chainIds registered as SOLANA (not EvmAddress)', () => {
    const addr = addressFor(SOLANA_MAINNET_CHAIN_ID, VALID_SOLANA);
    expect(addr).toBeInstanceOf(SolanaAddress);
    expect(addr).not.toBeInstanceOf(EvmAddress);
  });

  it('routes every Solana network (mainnet/testnet/devnet) through the SOLANA branch', () => {
    for (const chainId of [SOLANA_MAINNET_CHAIN_ID, SOLANA_TESTNET_CHAIN_ID, SOLANA_DEVNET_CHAIN_ID]) {
      expect(addressFor(chainId, VALID_SOLANA)).toBeInstanceOf(SolanaAddress);
    }
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

  it('preserves a Solana address verbatim — case-sensitive, never lowercased', () => {
    expect(canonicalizeAddress(SOLANA_MAINNET_CHAIN_ID, VALID_SOLANA)).toBe(VALID_SOLANA);
  });

  it('trims surrounding whitespace on a Solana address', () => {
    expect(canonicalizeAddress(SOLANA_MAINNET_CHAIN_ID, `  ${VALID_SOLANA}  `)).toBe(VALID_SOLANA);
  });

  it('throws on an invalid Solana address (delegated to SolanaAddress)', () => {
    expect(() => canonicalizeAddress(SOLANA_MAINNET_CHAIN_ID, 'not-an-address')).toThrow();
  });

  it('canonicalizes Solana addresses identically across testnet/devnet ids', () => {
    expect(canonicalizeAddress(SOLANA_TESTNET_CHAIN_ID, VALID_SOLANA)).toBe(VALID_SOLANA);
    expect(canonicalizeAddress(SOLANA_DEVNET_CHAIN_ID, VALID_SOLANA)).toBe(VALID_SOLANA);
  });

  it('tryCanonicalizeAddress returns the raw string unchanged for an invalid Solana address', () => {
    expect(tryCanonicalizeAddress(SOLANA_MAINNET_CHAIN_ID, 'not-an-address')).toBe('not-an-address');
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

  it('accepts a valid Solana address when the referenced chainId is SOLANA', () => {
    expect(validateSync(makeDto(SOLANA_MAINNET_CHAIN_ID, VALID_SOLANA))).toHaveLength(0);
  });

  it('rejects a malformed value when the referenced chainId is SOLANA', () => {
    const errors = validateSync(makeDto(SOLANA_MAINNET_CHAIN_ID, 'not-an-address'));
    expect(errors.find((error) => error.property === 'token')).toBeDefined();
  });
});
