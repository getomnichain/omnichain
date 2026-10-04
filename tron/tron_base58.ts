import { createHash } from 'node:crypto';

import bs58 from 'bs58';

import { bytesFromHex } from '../bytes_from_hex.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { pyDecodeUtf8 } from '../python_builtins.ts';

export const TRON_ADDRESS_PREFIX_BYTE = 0x41;

export function tronSha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function b58encodeCheck(payload: Uint8Array): string {
  const checksum = tronSha256(tronSha256(payload)).subarray(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return bs58.encode(full);
}

const PY_TRAILING_WHITESPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/;

export function b58decodeCheck(value: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value.replace(PY_TRAILING_WHITESPACE, ''));
  } catch (err) {
    throw new ChainError(
      ChainErrorKinds.InvalidAddress,
      `Invalid base58 string: ${JSON.stringify(value)}`,
      { address: value },
      err,
    );
  }
  if (decoded.length < 4) {
    throw new ChainError(ChainErrorKinds.InvalidAddress, 'Invalid checksum', { address: value });
  }
  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expected = tronSha256(tronSha256(payload)).subarray(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new ChainError(ChainErrorKinds.InvalidAddress, 'Invalid checksum', { address: value });
    }
  }
  return new Uint8Array(payload);
}

function badAddress(raw: unknown): ChainError {
  return new ChainError(
    ChainErrorKinds.InvalidAddress,
    `Bad Tron address: ${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)}`,
    typeof raw === 'string' ? { address: raw } : {},
  );
}

export function toBase58CheckAddress(raw: string | Uint8Array): string {
  if (typeof raw === 'string') {
    if (raw.length === 0) throw badAddress(raw);
    if (raw[0] === 'T' && raw.length === 34) {
      try {
        b58decodeCheck(raw);
      } catch (err) {
        throw new ChainError(ChainErrorKinds.InvalidAddress, 'bad base58check format', { address: raw }, err);
      }
      return raw;
    }
    if (raw.length === 42) {
      if (raw.startsWith('0x')) {
        return b58encodeCheck(Uint8Array.of(TRON_ADDRESS_PREFIX_BYTE, ...bytesFromHex(raw.slice(2))));
      }
      return b58encodeCheck(bytesFromHex(raw));
    }
    if (raw.startsWith('0x') && raw.length === 44) {
      return b58encodeCheck(bytesFromHex(raw.slice(2)));
    }
    throw badAddress(raw);
  }
  if (raw.length === 21 && raw[0] === TRON_ADDRESS_PREFIX_BYTE) {
    return b58encodeCheck(raw);
  }
  if (raw.length === 20) {
    return b58encodeCheck(Uint8Array.of(TRON_ADDRESS_PREFIX_BYTE, ...raw));
  }
  return toBase58CheckAddress(pyDecodeUtf8(raw));
}

export function isBase58CheckAddress(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value[0] !== 'T') return false;
  try {
    return b58decodeCheck(value).length === 21;
  } catch {
    return false;
  }
}
