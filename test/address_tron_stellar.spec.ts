import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Account, Keypair, MuxedAccount, StrKey } from '@stellar/stellar-sdk';
import { validateSync } from 'class-validator';

import { addressFor, canonicalizeAddress, tryCanonicalizeAddress } from '../address.factory.ts';
import { CHAIN_ID_STELLAR_MAINNET, CHAIN_ID_TRON_MAINNET } from '../chain_ids.ts';
import { IsAddress } from '../is_address.decorator.ts';
import { StellarAddress } from '../stellar/stellar_address.ts';
import { isValidStellarEd25519PublicKey, isValidStellarMed25519PublicKey } from '../stellar/stellar_strkey.ts';
import { TronAddress } from '../tron/tron_address.ts';
import { TronMainnet } from '../tron/tron_chains.ts';
import { toHexAddress } from '../tron/tron_keys.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_WRONG_PREFIX = 'TmhM7heCdKGPVk6xNWkeM2SKwE7N78cAjP';
const STELLAR_G = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const STELLAR_M = new MuxedAccount(new Account(STELLAR_G, '0'), '42').accountId();

class DtoUnderTest {
  chainId!: number;

  @IsAddress('chainId')
  token!: string;
}

function dto(chainId: number, token: string): DtoUnderTest {
  const value = new DtoUnderTest();
  value.chainId = chainId;
  value.token = token;
  return value;
}

describe('addressFor on Tron accepts what Python validate_wallet_address + format_wallet_address accept', () => {
  it('accepts a valid base58check T address and keeps it verbatim', () => {
    const address = addressFor(CHAIN_ID_TRON_MAINNET, TRON_USDT_CONTRACT);
    expect(address).toBeInstanceOf(TronAddress);
    expect(address.canonical()).toBe(TRON_USDT_CONTRACT);
  });

  it('accepts a T address with another prefix byte, as Python does', () => {
    expect(addressFor(CHAIN_ID_TRON_MAINNET, TRON_WRONG_PREFIX).canonical()).toBe(TRON_WRONG_PREFIX);
    expect(TronMainnet.validateAddress(TRON_WRONG_PREFIX)).toBe(true);
  });

  it.each([
    ['tronpy hex form 41…', toHexAddress(TRON_USDT_CONTRACT)],
    ['EVM 0x form', `0x${toHexAddress(TRON_USDT_CONTRACT).slice(2)}`],
    ['0x41… form', `0x${toHexAddress(TRON_USDT_CONTRACT)}`],
    ['bad checksum', `${TRON_USDT_CONTRACT.slice(0, -1)}u`],
    ['trailing whitespace', `${TRON_USDT_CONTRACT}\n`],
    ['empty string', ''],
  ])('rejects the %s', (_label, raw) => {
    expect(() => addressFor(CHAIN_ID_TRON_MAINNET, raw)).toThrow(/Invalid Tron address/);
    expect(tryCanonicalizeAddress(CHAIN_ID_TRON_MAINNET, raw)).toBe(raw);
    expect(TronMainnet.validateAddress(raw)).toBe(false);
  });

  it('@IsAddress rejects an EVM-shaped value on a Tron chain', () => {
    expect(validateSync(dto(CHAIN_ID_TRON_MAINNET, TRON_USDT_CONTRACT))).toHaveLength(0);
    const errors = validateSync(dto(CHAIN_ID_TRON_MAINNET, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'));
    expect(errors.find((error) => error.property === 'token')).toBeDefined();
  });
});

describe('addressFor on Stellar uses an SDK-free StrKey check', () => {
  it('accepts G and M account addresses verbatim', () => {
    expect(addressFor(CHAIN_ID_STELLAR_MAINNET, STELLAR_G)).toBeInstanceOf(StellarAddress);
    expect(canonicalizeAddress(CHAIN_ID_STELLAR_MAINNET, STELLAR_G)).toBe(STELLAR_G);
    expect(canonicalizeAddress(CHAIN_ID_STELLAR_MAINNET, STELLAR_M)).toBe(STELLAR_M);
  });

  it.each([
    ['secret seed', Keypair.random().secret()],
    ['contract id', StrKey.encodeContract(Buffer.alloc(32, 7))],
    ['lowercase account', STELLAR_G.toLowerCase()],
    ['bad checksum', `${STELLAR_G.slice(0, -1)}A`],
    ['padded base32', `${STELLAR_G}=`],
  ])('rejects a %s', (_label, raw) => {
    expect(() => addressFor(CHAIN_ID_STELLAR_MAINNET, raw)).toThrow(/Invalid Stellar wallet address/);
  });

  it('agrees with stellar-sdk StrKey on valid keys and on single-character mutations', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567a=0';
    for (let i = 0; i < 300; i++) {
      const g = Keypair.random().publicKey();
      const m = new MuxedAccount(new Account(g, '0'), String(i * 7919)).accountId();
      for (const valid of [g, m]) {
        const position = (i * 13) % valid.length;
        const mutated = valid.slice(0, position) + alphabet[i % alphabet.length] + valid.slice(position + 1);
        for (const candidate of [valid, mutated, valid.slice(1), `${valid}A`]) {
          expect(isValidStellarEd25519PublicKey(candidate)).toBe(StrKey.isValidEd25519PublicKey(candidate));
          expect(isValidStellarMed25519PublicKey(candidate)).toBe(StrKey.isValidMed25519PublicKey(candidate));
        }
      }
    }
  });

  it('the address factory import graph loads neither @stellar/stellar-sdk nor ethers', () => {
    const visited = new Set<string>();
    const heavyImports: string[] = [];
    const visit = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^(?:import|export)(?!\s+type)[^;]*?from '([^']+)';/gms)) {
        const specifier = match[1];
        if (specifier.startsWith('@stellar/') || specifier === 'ethers') heavyImports.push(`${file} -> ${specifier}`);
        if (specifier.startsWith('.')) visit(join(dirname(file), specifier));
      }
    };
    visit(join(ROOT, 'address.factory.ts'));
    expect(visited.has(join(ROOT, 'stellar', 'stellar_address.ts'))).toBe(true);
    expect(visited.has(join(ROOT, 'tron', 'tron_address.ts'))).toBe(true);
    expect(heavyImports).toEqual([]);
  });

  it('the root entry does not load the Stellar or Tron families, as Python\'s `import omnichain` does not', () => {
    const visited = new Set<string>();
    const stellarSdkImports: string[] = [];
    const visit = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^(?:import|export)(?!\s+type)[^;]*?from '([^']+)';/gms)) {
        const specifier = match[1];
        if (specifier.startsWith('@stellar/')) stellarSdkImports.push(`${file} -> ${specifier}`);
        if (specifier.startsWith('.')) visit(join(dirname(file), specifier));
      }
    };
    visit(join(ROOT, 'index.ts'));
    expect(visited.has(join(ROOT, 'stellar', 'index.ts'))).toBe(false);
    expect(visited.has(join(ROOT, 'tron', 'index.ts'))).toBe(false);
    expect(visited.has(join(ROOT, 'stellar', 'stellar_chain.ts'))).toBe(false);
    expect(visited.has(join(ROOT, 'tron', 'tron_chain.ts'))).toBe(false);
    expect(stellarSdkImports).toEqual([]);
  });
});
