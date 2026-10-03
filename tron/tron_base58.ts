import { createHash } from 'node:crypto';

import bs58 from 'bs58';

import { ChainError, ChainErrorKinds } from '../errors.ts';

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
