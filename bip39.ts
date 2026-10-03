import { createHash, pbkdf2Sync } from 'node:crypto';

import { Wordlist, wordlists } from 'ethers';

import { ChainError, ChainErrorKinds } from './errors.ts';

const BIP39_PBKDF2_ROUNDS = 2048;
const BIP39_SEED_BYTES = 64;
const BIP39_VALID_WORD_COUNTS: ReadonlySet<number> = new Set([12, 15, 18, 21, 24]);
const BIP_UTILS_LANGUAGE_ORDER = ['zh_cn', 'zh_tw', 'cz', 'en', 'fr', 'it', 'ko', 'pt', 'es'] as const;

const normalizedWordIndexCache = new Map<string, Map<string, number>>();

function nfkd(value: string): string {
  return value.normalize('NFKD');
}

function normalizedWordIndex(language: string, wordlist: Wordlist): Map<string, number> {
  let index = normalizedWordIndexCache.get(language);
  if (index === undefined) {
    index = new Map();
    for (let i = 0; i < 2048; i++) index.set(nfkd(wordlist.getWord(i)), i);
    normalizedWordIndexCache.set(language, index);
  }
  return index;
}

function wordIndexes(words: string[], language: string): number[] | null {
  const wordlist = (wordlists as Record<string, Wordlist>)[language];
  const index = normalizedWordIndex(language, wordlist);
  const out: number[] = [];
  for (const word of words) {
    const i = index.get(word);
    if (i === undefined) return null;
    out.push(i);
  }
  return out;
}

function checksumMatches(indexes: number[]): boolean {
  const bits = indexes.map((i) => i.toString(2).padStart(11, '0')).join('');
  const checksumLength = Math.floor(bits.length / 33);
  const entropyBits = bits.slice(0, checksumLength * 32);
  const checksumBits = bits.slice(bits.length - checksumLength);
  const entropy = Buffer.from(BigInt(`0b${entropyBits}`).toString(16).padStart(checksumLength * 8, '0'), 'hex');
  const hashBits = BigInt(`0x${createHash('sha256').update(entropy).digest('hex')}`).toString(2).padStart(256, '0');
  return hashBits.slice(0, checksumLength) === checksumBits;
}

function pbkdf2Seed(mnemonic: string, salt: string): Uint8Array {
  return new Uint8Array(pbkdf2Sync(Buffer.from(mnemonic, 'utf8'), Buffer.from(salt, 'utf8'), BIP39_PBKDF2_ROUNDS, BIP39_SEED_BYTES, 'sha512'));
}

export function isValidEnglishMnemonic(mnemonic: string): boolean {
  const words = nfkd(mnemonic).split(' ');
  if (!BIP39_VALID_WORD_COUNTS.has(words.length)) return false;
  const indexes = wordIndexes(words, 'en');
  return indexes !== null && checksumMatches(indexes);
}

export function mnemonicToSeedSep5(mnemonic: string, passphrase = ''): Uint8Array {
  if (!isValidEnglishMnemonic(mnemonic)) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      'Invalid mnemonic, please check if the mnemonic is correct, or if the language is set correctly.',
    );
  }
  return pbkdf2Seed(nfkd(mnemonic), `mnemonic${nfkd(passphrase)}`);
}

export function mnemonicToSeedBip39(mnemonic: string, passphrase = ''): Uint8Array {
  const words = mnemonic
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => nfkd(w.toLowerCase()));
  if (!BIP39_VALID_WORD_COUNTS.has(words.length)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Mnemonic words count is not valid (${words.length})`);
  }
  let indexes: number[] | null = null;
  for (const language of BIP_UTILS_LANGUAGE_ORDER) {
    indexes = wordIndexes(words, language);
    if (indexes !== null) break;
  }
  if (indexes === null) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, 'Invalid language for mnemonic');
  }
  if (!checksumMatches(indexes)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, 'Invalid checksum');
  }
  return pbkdf2Seed(words.join(' '), nfkd(`mnemonic${passphrase}`));
}
