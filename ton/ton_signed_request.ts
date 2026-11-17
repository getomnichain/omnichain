import { Cell, type Slice, type StateInit, beginCell, loadMessage, loadMessageRelaxed } from '@ton/core';
import { signVerify } from '@ton/crypto';

import { ChainError, ChainErrorKinds } from '../errors.ts';
import { TON_MAX_MESSAGES_PER_REQUEST, TON_W5_SIGNED_EXTERNAL_OP, TON_W5_SIGNED_INTERNAL_OP, type TonW5RequestFields } from './ton_messages.ts';
import { type TonWorkchain, tonPublicKeyOf } from './ton_wallet_contracts.ts';

const SIGNATURE_BITS = 512;
const OUT_ACTION_SEND_MSG_TAG = 0x0ec3c86d;
const EXTENDED_ADD_EXTENSION_TAG = 0x02;
const EXTENDED_REMOVE_EXTENSION_TAG = 0x03;
const EXTENDED_SET_SIGNATURE_AUTH_TAG = 0x04;
const TON_MAINNET_GLOBAL_ID = -239;

/** A message a signed W5 request sends, as signed. */
export interface TonSignedRequestMessage {
  /** Raw form. */
  to: string;
  value: bigint;
  bounce: boolean;
  /** `null` for an empty body. */
  body: Cell | null;
  stateInit: StateInit | null;
  mode: number;
}

/** A W5 action that sends nothing: it changes the wallet's extensions or signature auth. */
export type TonExtendedAction =
  | { type: 'add_extension'; address: string }
  | { type: 'remove_extension'; address: string }
  | { type: 'set_signature_auth_allowed'; allowed: boolean };

/** A signed W5 request read back in full, whoever signed it. */
export interface TonSignedRequest extends TonW5RequestFields {
  messages: TonSignedRequestMessage[];
  extendedActions: TonExtendedAction[];
  signature: Buffer;
  /** The hash the signature covers: the body without its trailing signature. */
  signedHash: Buffer;
  /** The signed body, as `tonInternalRequestOf` and `tonRelayMessage` take it. */
  body: Cell;
  /** Raw form; set when the input was an internal message carrying the request, such as TonConnect's `internalBoc`. */
  destination: string | null;
}

/**
 * Reads a signed W5 (v5r1) request: the body itself, or an internal message
 * carrying it. Every cell must be read to its end, so nothing the wallet would
 * execute is left unread. Throws `TransactionDecodeFailed` for anything else.
 */
export function tonSignedRequestOf(input: string | Cell): TonSignedRequest {
  try {
    const root = typeof input === 'string' ? Cell.fromBase64(input) : input;
    const { body, destination } = requestBodyOf(root);
    return { ...readRequest(body), body, destination };
  } catch (err) {
    if (err instanceof ChainError) throw err;
    throw decodeFailed((err as Error).message, err as Error);
  }
}

/** Whether `request` was signed by `publicKey` (32 bytes or 64 hex characters). */
export function verifyTonW5Request(request: Pick<TonSignedRequest, 'signature' | 'signedHash'>, publicKey: Uint8Array | string): boolean {
  const key = tonPublicKeyOf(publicKey);
  try {
    return signVerify(request.signedHash, request.signature, key);
  } catch {
    return false;
  }
}

/**
 * The wallet id a W5 on `workchain` has by default on mainnet, as `TonWallet`
 * builds it (subwallet 0), in the signed form `tonW5RequestFields` reads.
 */
export function tonW5DefaultWalletId(workchain: TonWorkchain = 0): number {
  // Client context: flag bit, workchain (int8), wallet version (v5r1 = 0), subwallet (15 bits).
  const context = (1 << 31) | ((workchain & 0xff) << 23);
  return TON_MAINNET_GLOBAL_ID ^ context;
}

function requestBodyOf(root: Cell): { body: Cell; destination: string | null } {
  if (isRequestBody(root)) return { body: root, destination: null };
  const slice = root.beginParse();
  const message = loadMessage(slice);
  slice.endParse();
  if (message.info.type !== 'internal') throw decodeFailed(`a ${message.info.type} message does not carry a relayed request`);
  if (!isRequestBody(message.body)) throw decodeFailed('the message body is not a signed W5 request');
  return { body: message.body, destination: message.info.dest.toRawString() };
}

function isRequestBody(cell: Cell): boolean {
  if (cell.bits.length < 32) return false;
  const op = cell.beginParse().loadUint(32);
  return op === TON_W5_SIGNED_INTERNAL_OP || op === TON_W5_SIGNED_EXTERNAL_OP;
}

function readRequest(body: Cell): Omit<TonSignedRequest, 'body' | 'destination'> {
  const slice = body.beginParse();
  const op = slice.loadUint(32);
  const fields: TonW5RequestFields = {
    authType: op === TON_W5_SIGNED_EXTERNAL_OP ? 'external' : 'internal',
    walletId: slice.loadInt(32),
    validUntil: slice.loadUint(32),
    seqno: slice.loadUint(32),
  };
  const outList = slice.loadMaybeRef();
  const messages = outList === null ? [] : sendActionsOf(outList);
  const extendedActions = slice.loadBit() ? extendedActionsOf(slice) : [];
  if (slice.remainingBits !== SIGNATURE_BITS || slice.remainingRefs !== 0) {
    throw decodeFailed('the body carries data after its actions');
  }
  const signature = slice.loadBuffer(SIGNATURE_BITS / 8);
  return { ...fields, messages, extendedActions, signature, signedHash: signedPartOf(body).hash() };
}

/** The out list, oldest action first: each cell holds the previous list, then one send. */
function sendActionsOf(list: Cell): TonSignedRequestMessage[] {
  const messages: TonSignedRequestMessage[] = [];
  let cell = list;
  while (cell.bits.length > 0 || cell.refs.length > 0) {
    if (messages.length === TON_MAX_MESSAGES_PER_REQUEST) {
      throw decodeFailed(`a W5 request sends at most ${TON_MAX_MESSAGES_PER_REQUEST} messages`);
    }
    const slice = cell.beginParse();
    const previous = slice.loadRef();
    if (slice.loadUint(32) !== OUT_ACTION_SEND_MSG_TAG) throw decodeFailed('a W5 out list holds only send-message actions');
    const mode = slice.loadUint(8);
    messages.push(sentMessageOf(slice.loadRef(), mode));
    slice.endParse();
    cell = previous;
  }
  return messages.reverse();
}

function sentMessageOf(cell: Cell, mode: number): TonSignedRequestMessage {
  const slice = cell.beginParse();
  const message = loadMessageRelaxed(slice);
  slice.endParse();
  if (message.info.type !== 'internal') throw decodeFailed('a W5 request sends internal messages only');
  if (message.info.value.other && message.info.value.other.size > 0) throw decodeFailed('extra currencies are not supported');
  const empty = message.body.bits.length === 0 && message.body.refs.length === 0;
  return {
    to: message.info.dest.toRawString(),
    value: message.info.value.coins,
    bounce: message.info.bounce,
    body: empty ? null : message.body,
    stateInit: message.init ?? null,
    mode,
  };
}

/** The first extended action sits in the body; each further one in a cell of its own, chained by reference. */
function extendedActionsOf(slice: Slice): TonExtendedAction[] {
  const actions = [extendedActionOf(slice)];
  let next = slice.remainingRefs > 0 ? slice.loadRef() : null;
  while (next !== null) {
    const cell = next.beginParse();
    actions.push(extendedActionOf(cell));
    next = cell.remainingRefs > 0 ? cell.loadRef() : null;
    cell.endParse();
  }
  return actions;
}

function extendedActionOf(slice: Slice): TonExtendedAction {
  const tag = slice.loadUint(8);
  if (tag === EXTENDED_ADD_EXTENSION_TAG) return { type: 'add_extension', address: slice.loadAddress().toRawString() };
  if (tag === EXTENDED_REMOVE_EXTENSION_TAG) return { type: 'remove_extension', address: slice.loadAddress().toRawString() };
  if (tag === EXTENDED_SET_SIGNATURE_AUTH_TAG) return { type: 'set_signature_auth_allowed', allowed: slice.loadBit() };
  throw decodeFailed(`unknown W5 extended action 0x${tag.toString(16)}`);
}

/** What W5 signs: the body's bits without the trailing signature, with all its references. */
function signedPartOf(body: Cell): Cell {
  const builder = beginCell().storeBits(body.bits.substring(0, body.bits.length - SIGNATURE_BITS));
  for (const ref of body.refs) builder.storeRef(ref);
  return builder.endCell();
}

function decodeFailed(reason: string, cause?: Error): ChainError {
  return new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Not a signed W5 request: ${reason}`, undefined, cause);
}
