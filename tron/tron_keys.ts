import { SigningKey, getBytes, keccak256 as ethersKeccak256 } from 'ethers';

import { bytesFromHex } from '../bytes_from_hex.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { pyDecodeUtf8, pyEncodeUtf8 } from '../python_builtins.ts';
import {
  TRON_ADDRESS_PREFIX_BYTE,
  b58decodeCheck,
  b58encodeCheck,
  isBase58CheckAddress,
  toBase58CheckAddress,
  tronSha256,
} from './tron_base58.ts';

export {
  TRON_ADDRESS_PREFIX_BYTE,
  b58decodeCheck,
  b58encodeCheck,
  isBase58CheckAddress,
  toBase58CheckAddress,
  tronSha256,
} from './tron_base58.ts';

export const SECPK1_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;
export const TRON_MESSAGE_PREFIX = '\x19TRON Signed Message:\n';

export function tronKeccak256(data: Uint8Array): Uint8Array {
  return getBytes(ethersKeccak256(data));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function hexToBytes(hex: string): Uint8Array {
  return bytesFromHex(hex);
}

export function toHexAddress(raw: string | Uint8Array): string {
  return bytesToHex(b58decodeCheck(toBase58CheckAddress(raw)));
}

export function toRawAddress(raw: string | Uint8Array): Uint8Array {
  return b58decodeCheck(toBase58CheckAddress(raw));
}

export function toTvmAddress(raw: string | Uint8Array): Uint8Array {
  return toRawAddress(raw).subarray(1);
}

export function isHexAddress(value: string): boolean {
  if (typeof value !== 'string' || !value.startsWith('41')) return false;
  try {
    return hexToBytes(value).length === 21;
  } catch {
    return false;
  }
}

export function isTronAddress(value: string): boolean {
  return isBase58CheckAddress(value) || isHexAddress(value);
}

export function publicKeyToBase58CheckAddress(publicKey: Uint8Array): string {
  return b58encodeCheck(publicKeyToAddressBytes(publicKey));
}

export function publicKeyToAddressBytes(publicKey: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(TRON_ADDRESS_PREFIX_BYTE), tronKeccak256(publicKey).subarray(12));
}

export function hashTronMessage(message: string | Uint8Array): Uint8Array {
  const messageBytes = typeof message === 'string' ? pyEncodeUtf8(message) : message;
  const length = new TextEncoder().encode(String(messageBytes.length));
  return tronKeccak256(concatBytes(new TextEncoder().encode(TRON_MESSAGE_PREFIX), length, messageBytes));
}

export class TronPublicKey {
  private readonly rawKey: Uint8Array;

  constructor(publicKeyBytes: Uint8Array) {
    if (!(publicKeyBytes instanceof Uint8Array)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'public_key_bytes must be bytes');
    }
    if (publicKeyBytes.length !== 64) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `public_key_bytes must be 64 bytes long, got ${publicKeyBytes.length}`,
      );
    }
    this.rawKey = new Uint8Array(publicKeyBytes);
  }

  static fromHex(hex: string): TronPublicKey {
    return new TronPublicKey(hexToBytes(hex));
  }

  static recoverFromMsg(message: string | Uint8Array, signature: TronSignature): TronPublicKey {
    return signature.recoverPublicKeyFromMsg(message);
  }

  static recoverFromMsgHash(messageHash: Uint8Array, signature: TronSignature): TronPublicKey {
    return signature.recoverPublicKeyFromMsgHash(messageHash);
  }

  verifyMsg(message: string | Uint8Array, signature: TronSignature): boolean {
    return signature.verifyMsg(message, this);
  }

  verifyMsgHash(messageHash: Uint8Array, signature: TronSignature): boolean {
    return signature.verifyMsgHash(messageHash, this);
  }

  toBase58CheckAddress(): string {
    return publicKeyToBase58CheckAddress(this.rawKey);
  }

  toHexAddress(): string {
    return bytesToHex(publicKeyToAddressBytes(this.rawKey));
  }

  toAddress(): Uint8Array {
    return publicKeyToAddressBytes(this.rawKey);
  }

  toTvmAddress(): Uint8Array {
    return publicKeyToAddressBytes(this.rawKey).subarray(1);
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.rawKey);
  }

  hex(): string {
    return bytesToHex(this.rawKey);
  }

  equals(other: TronPublicKey): boolean {
    return this.hex() === other.hex();
  }

  toString(): string {
    return this.hex();
  }
}

export class TronPrivateKey {
  readonly #rawKey: Uint8Array;
  readonly publicKey: TronPublicKey;

  constructor(privateKeyBytes: Uint8Array) {
    if (!(privateKeyBytes instanceof Uint8Array)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'private_key_bytes must be bytes');
    }
    if (privateKeyBytes.length !== 32) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `private_key_bytes must be 32 bytes long, got ${privateKeyBytes.length}`,
      );
    }
    const scalar = BigInt(`0x${bytesToHex(privateKeyBytes)}`);
    if (!(scalar > 0n && scalar < SECPK1_N)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'private key is not in the valid range');
    }
    this.#rawKey = new Uint8Array(privateKeyBytes);
    const uncompressed = getBytes(SigningKey.computePublicKey(this.#rawKey, false));
    this.publicKey = new TronPublicKey(uncompressed.subarray(1));
  }

  static fromHex(hex: string): TronPrivateKey {
    return new TronPrivateKey(hexToBytes(hex));
  }

  static fromPassphrase(passphrase: Uint8Array): TronPrivateKey {
    return new TronPrivateKey(tronSha256(passphrase));
  }

  signMsg(message: string | Uint8Array): TronSignature {
    return this.signMsgHash(hashTronMessage(message));
  }

  signMsgHash(messageHash: Uint8Array): TronSignature {
    const signature = new SigningKey(this.#rawKey).sign(messageHash);
    return new TronSignature(concatBytes(getBytes(signature.r), getBytes(signature.s), Uint8Array.of(signature.yParity)));
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.#rawKey);
  }

  hex(): string {
    return bytesToHex(this.#rawKey);
  }
}

export class TronSignature {
  private readonly rawSignature: Uint8Array;

  constructor(signatureBytes: Uint8Array) {
    if (!(signatureBytes instanceof Uint8Array)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'signature_bytes must be bytes');
    }
    if (signatureBytes.length !== 65) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `signature_bytes must be 65 bytes long, got ${signatureBytes.length}`,
      );
    }
    this.rawSignature = concatBytes(signatureBytes.subarray(0, 64), Uint8Array.of(TronSignature.normalizeV(signatureBytes[64])));
  }

  static fromHex(hex: string): TronSignature {
    return new TronSignature(hexToBytes(hex));
  }

  static normalizeV(v: number): number {
    if (v === 0 || v === 27) return 0;
    if (v === 1 || v === 28) return 1;
    if (v < 35) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `invalid v ${v}`);
    }
    return v % 2 !== 1 ? 1 : 0;
  }

  get r(): bigint {
    return BigInt(`0x${bytesToHex(this.rawSignature.subarray(0, 32))}`);
  }

  get s(): bigint {
    return BigInt(`0x${bytesToHex(this.rawSignature.subarray(32, 64))}`);
  }

  get v(): number {
    return this.rawSignature[64];
  }

  recoverPublicKeyFromMsg(message: string | Uint8Array): TronPublicKey {
    return this.recoverPublicKeyFromMsgHash(hashTronMessage(message));
  }

  recoverPublicKeyFromMsgHash(messageHash: Uint8Array): TronPublicKey {
    return TronSignature.recover(messageHash, this.r, this.s, this.v);
  }

  verifyMsg(message: string | Uint8Array, publicKey: TronPublicKey): boolean {
    return this.verifyMsgHash(hashTronMessage(message), publicKey);
  }

  verifyMsgHash(messageHash: Uint8Array, publicKey: TronPublicKey): boolean {
    const lowS = this.s < SECPK1_N - this.s ? this.s : SECPK1_N - this.s;
    for (const parity of [0, 1]) {
      try {
        if (TronSignature.recover(messageHash, this.r, lowS, parity).equals(publicKey)) return true;
      } catch {
        continue;
      }
    }
    return false;
  }

  hex(): string {
    return bytesToHex(this.rawSignature);
  }

  tronwebHex(): string {
    return `${this.r.toString(16).padStart(64, '0')}${this.s.toString(16).padStart(64, '0')}${(this.v + 27).toString(16).padStart(2, '0')}`;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.rawSignature);
  }

  toString(): string {
    return this.hex();
  }

  private static recover(messageHash: Uint8Array, r: bigint, s: bigint, parity: number): TronPublicKey {
    if (s > SECPK1_N / 2n) return TronSignature.recover(messageHash, r, SECPK1_N - s, parity ^ 1);
    const recovered = SigningKey.recoverPublicKey(messageHash, {
      r: `0x${r.toString(16).padStart(64, '0')}`,
      s: `0x${s.toString(16).padStart(64, '0')}`,
      v: 27 + parity,
    });
    return new TronPublicKey(getBytes(recovered).subarray(1));
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
