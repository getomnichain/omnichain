import { AbiCoder, ParamType } from 'ethers';

import { ChainError, ChainErrorKinds } from '../errors.ts';
import { pyDecodeUtf8, pyEncodeUtf8 } from '../python_builtins.ts';
import { pyRepr, pyTypeRepr } from '../python_repr.ts';
import { b58decodeCheck } from './tron_base58.ts';
import { bytesToHex, isHexAddress, toBase58CheckAddress, toTvmAddress } from './tron_keys.ts';

const abiCoder = AbiCoder.defaultAbiCoder();
const WORD = 32n;
const PY_SSIZE_T_MAX = 2n ** 63n - 1n;

export function tronAbiEncodeSingle(typeString: string, values: unknown): string {
  const type = ParamType.from(typeString);
  validateValue(type, values);
  if (type.baseType === 'tuple') {
    return abiCoder.encode([...(type.components ?? [])], toEthersValue(type, values) as unknown[]).slice(2);
  }
  return abiCoder.encode([type], [toEthersValue(type, values)]).slice(2);
}

export function tronAbiDecodeSingle(typeString: string, data: Uint8Array): unknown {
  if (typeString === '()') throw new ChainError(ChainErrorKinds.InvalidArgument, 'Zero-sized tuple types "()" are not supported.');
  return decode(ParamType.from(typeString), new FramedStream(data));
}

function encoderName(type: ParamType): string {
  if (type.baseType === 'tuple') return 'TupleEncoder';
  if (type.baseType === 'array') return type.arrayLength === -1 ? 'DynamicArrayEncoder' : 'SizedArrayEncoder';
  if (type.baseType === 'bool') return 'BooleanEncoder';
  if (type.baseType === 'address') return 'TronAddressEncoder';
  if (type.baseType === 'string') return 'TextStringEncoder';
  if (type.baseType === 'bytes') return 'ByteStringEncoder';
  if (/^bytes\d+$/.test(type.baseType)) return 'BytesEncoder';
  return type.baseType.startsWith('uint') ? 'UnsignedIntegerEncoder' : 'SignedIntegerEncoder';
}

function abbr(value: unknown): string {
  const rep = pyRepr(value);
  return rep.length > 79 ? `${rep.slice(0, 76)}...` : rep;
}

function invalidate(type: ParamType, value: unknown, message?: string): never {
  throw new ChainError(
    ChainErrorKinds.InvalidArgument,
    `Value \`${abbr(value)}\` of type ${pyTypeRepr(value)} cannot be encoded by ${encoderName(type)}${message === undefined ? '' : `: ${message}`}`,
  );
}

function isPyInteger(value: unknown): value is bigint | number {
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value));
}

function validateValue(type: ParamType, value: unknown): void {
  const base = type.baseType;
  if (base === 'tuple' || base === 'array') {
    if (!Array.isArray(value)) {
      invalidate(type, value, base === 'tuple' ? 'must be list-like object such as array or tuple' : 'must be list-like such as array or tuple');
    }
    if (base === 'tuple') {
      const components = type.components ?? [];
      if (value.length !== components.length) {
        invalidate(type, value, `value has ${value.length} items when ${components.length} were expected`);
      }
      components.forEach((component, i) => validateValue(component, value[i]));
      return;
    }
    for (const item of value) validateValue(type.arrayChildren as ParamType, item);
    if (type.arrayLength !== -1 && value.length !== type.arrayLength) {
      invalidate(type, value, `value has ${value.length} items when ${type.arrayLength} were expected`);
    }
    return;
  }
  if (base === 'bool') {
    if (typeof value !== 'boolean') invalidate(type, value);
    return;
  }
  if (base === 'address') {
    if (!tronpyIsAddress(value)) invalidate(type, value);
    return;
  }
  if (base === 'string') {
    if (typeof value !== 'string') invalidate(type, value);
    pyEncodeUtf8(value);
    return;
  }
  if (base === 'bytes' || /^bytes\d+$/.test(base)) {
    if (!(value instanceof Uint8Array)) invalidate(type, value);
    const size = base === 'bytes' ? null : Number(base.slice(5));
    if (size !== null && value.length > size) invalidate(type, value, `exceeds total byte size for bytes${size} encoding`);
    return;
  }
  const bits = Number(base.replace(/^u?int/, '') || '256');
  if (!isPyInteger(value)) invalidate(type, value);
  const integer = BigInt(value);
  const [lower, upper] = base.startsWith('uint')
    ? [0n, 2n ** BigInt(bits) - 1n]
    : [-(2n ** BigInt(bits - 1)), 2n ** BigInt(bits - 1) - 1n];
  if (integer < lower || integer > upper) {
    invalidate(type, value, `Cannot be encoded in ${bits} bits. Must be bounded between [${lower}, ${upper}].`);
  }
}

function tronpyIsAddress(value: unknown): boolean {
  if (typeof value !== 'string') {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `'${pyTypeRepr(value).slice(8, -2)}' object is not subscriptable`);
  }
  if (value.length === 0) throw new ChainError(ChainErrorKinds.InvalidArgument, 'string index out of range');
  if (value[0] === 'T' && b58decodeCheck(value).length === 21) return true;
  return value.startsWith('41') && isHexAddress(value);
}

function toEthersValue(type: ParamType, value: unknown): unknown {
  const base = type.baseType;
  if (base === 'tuple') return (value as unknown[]).map((item, i) => toEthersValue((type.components as readonly ParamType[])[i], item));
  if (base === 'array') return (value as unknown[]).map((item) => toEthersValue(type.arrayChildren as ParamType, item));
  if (base === 'address') return `0x${bytesToHex(toTvmAddress(value as string))}`;
  if (/^bytes\d+$/.test(base)) {
    const padded = new Uint8Array(Number(base.slice(5)));
    padded.set(value as Uint8Array);
    return padded;
  }
  return value;
}

class FramedStream {
  position = 0n;
  private totalOffset = 0n;
  private readonly frames: Array<[bigint, bigint]> = [];

  constructor(readonly data: Uint8Array) {}

  get length(): bigint {
    return BigInt(this.data.length);
  }

  read(size: bigint): Uint8Array {
    const start = this.position > this.length ? this.length : this.position;
    const end = this.position + size > this.length ? this.length : this.position + size;
    this.position += size;
    return this.data.subarray(Number(start), Number(end < start ? start : end));
  }

  pushFrame(offset: bigint): void {
    this.frames.push([offset, this.position]);
    this.totalOffset += offset;
    this.position = this.totalOffset;
  }

  popFrame(): void {
    const [offset, returnPosition] = this.frames.pop() as [bigint, bigint];
    this.totalOffset -= offset;
    this.position = returnPosition;
  }
}

function decodingError(message: string): ChainError {
  return new ChainError(ChainErrorKinds.TransactionDecodeFailed, message);
}

function isDynamic(type: ParamType): boolean {
  if (type.baseType === 'string' || type.baseType === 'bytes') return true;
  if (type.baseType === 'array') return type.arrayLength === -1 || isDynamic(type.arrayChildren as ParamType);
  if (type.baseType === 'tuple') return (type.components ?? []).some(isDynamic);
  return false;
}

function readWord(stream: FramedStream): Uint8Array {
  const data = stream.read(WORD);
  if (data.length !== 32) throw decodingError(`Tried to read 32 bytes, only got ${data.length} bytes.`);
  return data;
}

function readUint256(stream: FramedStream): bigint {
  return BigInt(`0x${bytesToHex(readWord(stream))}`);
}

function headSlots(type: ParamType): number {
  return type.baseType === 'array' && type.arrayLength !== -1 && !isDynamic(type) ? (type.arrayLength as number) : 1;
}

function validatePointers(stream: FramedStream, items: ParamType[], container: 'tuple' | 'array'): void {
  const current = stream.position;
  const endOfOffsets = current + WORD * BigInt(container === 'tuple' ? items.reduce((sum, item) => sum + headSlots(item), 0) : items.length);
  for (const item of items) {
    if (isDynamic(item)) {
      const offset = readUint256(stream);
      const indicated = current + offset;
      if (indicated < endOfOffsets || indicated >= stream.length) {
        throw decodingError(`Invalid pointer in ${container} at location ${stream.position - WORD} in payload`);
      }
    } else if (container === 'tuple') {
      decode(item, stream);
    }
  }
  stream.position = current;
}

function decodeItem(type: ParamType, stream: FramedStream): unknown {
  if (!isDynamic(type)) return decode(type, stream);
  const start = readUint256(stream);
  stream.pushFrame(start);
  const value = decode(type, stream);
  stream.popFrame();
  return value;
}

function decode(type: ParamType, stream: FramedStream): unknown {
  const base = type.baseType;
  if (base === 'tuple') {
    const components = [...(type.components ?? [])];
    validatePointers(stream, components, 'tuple');
    return components.map((component) => decodeItem(component, stream));
  }
  if (base === 'array') {
    const child = type.arrayChildren as ParamType;
    if (type.arrayLength === -1) {
      const size = readUint256(stream);
      stream.pushFrame(WORD);
      if (isDynamic(child)) validatePointers(stream, Array.from({ length: Number(size > 1_000_000n ? 1_000_000n : size) }, () => child), 'array');
      const items: unknown[] = [];
      for (let i = 0n; i < size; i++) items.push(decodeItem(child, stream));
      stream.popFrame();
      return items;
    }
    const children = Array.from({ length: type.arrayLength as number }, () => child);
    if (isDynamic(child)) validatePointers(stream, children, 'array');
    return children.map((item) => decodeItem(item, stream));
  }
  if (base === 'string' || base === 'bytes') {
    const length = readUint256(stream);
    const padded = ((length + 31n) / WORD) * WORD;
    if (padded > PY_SSIZE_T_MAX) throw decodingError("cannot fit 'int' into an index-sized integer");
    const data = stream.read(padded);
    if (BigInt(data.length) < padded) throw decodingError(`Tried to read ${padded} bytes, only got ${data.length} bytes`);
    const padding = data.subarray(Number(length));
    if (padding.some((byte) => byte !== 0)) throw decodingError(`Padding bytes were not empty: ${pyRepr(padding)}`);
    const value = data.subarray(0, Number(length));
    return base === 'string' ? pyDecodeUtf8(value) : new Uint8Array(value);
  }
  const word = readWord(stream);
  if (base === 'bool') {
    const value = word.subarray(31);
    if (value[0] !== 0 && value[0] !== 1) throw decodingError(`Boolean must be either 0x0 or 0x1.  Got: ${pyRepr(value)}`);
    assertZeroPadding(word.subarray(0, 31));
    return value[0] === 1;
  }
  if (base === 'address') {
    const padding = word.subarray(0, 12);
    const tronPrefixed = padding.subarray(0, 11).every((byte) => byte === 0) && padding[11] === 0x41;
    if (!tronPrefixed) assertZeroPadding(padding);
    return toBase58CheckAddress(word.subarray(12));
  }
  if (/^bytes\d+$/.test(base)) {
    const size = Number(base.slice(5));
    assertZeroPadding(word.subarray(size));
    return new Uint8Array(word.subarray(0, size));
  }
  const bits = Number(base.replace(/^u?int/, '') || '256');
  const valueBytes = word.subarray(32 - bits / 8);
  const padding = word.subarray(0, 32 - bits / 8);
  let value = BigInt(`0x${bytesToHex(valueBytes) || '0'}`);
  if (base.startsWith('int') && value >= 2n ** BigInt(bits - 1)) value -= 2n ** BigInt(bits);
  const expected = base.startsWith('int') && value < 0n ? 0xff : 0x00;
  if (padding.some((byte) => byte !== expected)) throw decodingError(`Padding bytes were not empty: ${pyRepr(padding)}`);
  return value;
}

function assertZeroPadding(padding: Uint8Array): void {
  if (padding.some((byte) => byte !== 0)) throw decodingError(`Padding bytes were not empty: ${pyRepr(padding)}`);
}
