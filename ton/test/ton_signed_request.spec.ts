import { Address, Cell, SendMode, beginCell, internal, loadMessage, storeMessageRelaxed } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';

import { ChainErrorKinds } from '../../errors.ts';
import { type TonOutMessage, tonCommentBody, tonJettonTransferBody, tonW5RequestFields } from '../ton_messages.ts';
import { tonSignedRequestOf, tonW5DefaultWalletId, verifyTonW5Request } from '../ton_signed_request.ts';
import { TonWallet } from '../ton_wallet.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
const JETTON_WALLET = '0:9d1e1843624c4d175a695a8c2de8a5a61f03b93336e8caa4e164bf6cbbab205e';
const VALID_UNTIL = 2_000_000_000;

const wallet = TonWallet.fromMnemonic(MNEMONIC);
const stranger = TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath({ account: 1 }) });

const jettonBody = tonJettonTransferBody({ amount: 10_000n, destination: OTHER, responseDestination: wallet.address, forwardTonAmount: 1n });
const messages: TonOutMessage[] = [
  { to: OTHER, value: 7n, body: tonCommentBody('memo'), bounce: false, mode: SendMode.PAY_GAS_SEPARATELY },
  { to: JETTON_WALLET, value: 50_000_000n, body: jettonBody, mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS },
  { to: OTHER, value: 1n, stateInit: stranger.stateInit, mode: SendMode.NONE },
];

function request(seqno = 3, list = messages) {
  return wallet.createInternalRequest({ seqno, validUntil: VALID_UNTIL, messages: list });
}

/** `body`'s signed part with `signature` at its tail: what a relayer could forge from a real request. */
function withSignature(body: Cell, signature: Buffer): Cell {
  const builder = beginCell().storeBits(body.bits.substring(0, body.bits.length - 512)).storeBuffer(signature);
  for (const ref of body.refs) builder.storeRef(ref);
  return builder.endCell();
}

function signatureOf(body: Cell): Buffer {
  return tonSignedRequestOf(body).signature;
}

function expectDecodeFailed(input: string | Cell): void {
  expect(() => tonSignedRequestOf(input)).toThrow(expect.objectContaining({ kind: ChainErrorKinds.TransactionDecodeFailed }));
}

describe('tonSignedRequestOf', () => {
  it('reads every message of a request exactly as signed, and its fields', () => {
    const { body } = request();
    const read = tonSignedRequestOf(body.toBoc().toString('base64'));
    expect(read).toMatchObject({ authType: 'internal', seqno: 3, validUntil: VALID_UNTIL, walletId: tonW5RequestFields(body).walletId });
    expect(read.destination).toBeNull();
    expect(read.extendedActions).toEqual([]);
    expect(read.body.hash()).toEqual(body.hash());
    expect(read.messages).toHaveLength(3);
    expect(read.messages[0]).toMatchObject({ to: OTHER, value: 7n, bounce: false, stateInit: null, mode: SendMode.PAY_GAS_SEPARATELY });
    expect(read.messages[0].body!.hash()).toEqual(tonCommentBody('memo').hash());
    expect(read.messages[1]).toMatchObject({ to: JETTON_WALLET, value: 50_000_000n, bounce: true, mode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS });
    expect(read.messages[1].body!.hash()).toEqual(jettonBody.hash());
    expect(read.messages[2]).toMatchObject({ to: OTHER, value: 1n, body: null, bounce: false, mode: SendMode.NONE });
    expect(read.messages[2].stateInit!.code!.hash()).toEqual(stranger.stateInit.code!.hash());
    expect(read.messages[2].stateInit!.data!.hash()).toEqual(stranger.stateInit.data!.hash());
  });

  it("reads TonConnect's internalBoc: the request inside an internal message to the wallet", () => {
    const { body } = request();
    const internalBoc = beginCell()
      .store(storeMessageRelaxed(internal({ to: Address.parse(wallet.address), value: 0n, body })))
      .endCell()
      .toBoc()
      .toString('base64');
    const read = tonSignedRequestOf(internalBoc);
    expect(read.destination).toBe(wallet.address);
    expect(read.body.hash()).toEqual(body.hash());
    expect(read.messages).toHaveLength(3);
  });

  it('reads an external request as external, for the caller to refuse', () => {
    const { boc } = wallet.createExternalRequest({ seqno: 1, validUntil: VALID_UNTIL, messages: [{ to: OTHER, value: 1n }] });
    const { body } = loadMessage(Cell.fromBase64(boc).beginParse());
    expect(tonSignedRequestOf(body)).toMatchObject({ authType: 'external', seqno: 1 });
    expectDecodeFailed(boc);
  });

  it('lists extended actions apart from messages', async () => {
    const { secretKey } = await mnemonicToPrivateKey(MNEMONIC.split(' '));
    const contract = WalletContractV5R1.create({ workchain: 0, publicKey: wallet.publicKey });
    const body = contract.createRequest({
      seqno: 4,
      timeout: VALID_UNTIL,
      secretKey,
      authType: 'internal',
      actions: [
        { type: 'sendMsg', mode: SendMode.PAY_GAS_SEPARATELY, outMsg: internal({ to: OTHER, value: 1n }) },
        { type: 'addExtension', address: Address.parse(OTHER) },
        { type: 'removeExtension', address: Address.parse(JETTON_WALLET) },
        { type: 'setIsPublicKeyEnabled', isEnabled: false },
      ],
    });
    const read = tonSignedRequestOf(body);
    expect(read.messages).toHaveLength(1);
    expect(read.extendedActions).toEqual([
      { type: 'add_extension', address: OTHER },
      { type: 'remove_extension', address: JETTON_WALLET },
      { type: 'set_signature_auth_allowed', allowed: false },
    ]);
    expect(verifyTonW5Request(read, wallet.publicKey)).toBe(true);
  });

  it('refuses what is not a signed W5 request', () => {
    const legacy = TonWallet.fromMnemonic(MNEMONIC, { version: 'v4r2' });
    const { boc } = legacy.createExternalRequest({ seqno: 1, validUntil: VALID_UNTIL, messages: [{ to: OTHER, value: 1n }] });
    expectDecodeFailed(loadMessage(Cell.fromBase64(boc).beginParse()).body);

    const { body } = request();
    expectDecodeFailed(beginCell().storeSlice(body.beginParse()).storeUint(1, 1).endCell());
    expectDecodeFailed(body.toBoc().toString('base64').slice(0, 40));
    expectDecodeFailed(
      beginCell().store(storeMessageRelaxed(internal({ to: Address.parse(wallet.address), value: 0n, body: tonCommentBody('hi') }))).endCell(),
    );
  });
});

describe('verifyTonW5Request', () => {
  const { body } = request();
  const signature = signatureOf(body);

  it("accepts the wallet's own key only", () => {
    const read = tonSignedRequestOf(body);
    expect(verifyTonW5Request(read, wallet.publicKey)).toBe(true);
    expect(verifyTonW5Request(read, Buffer.from(wallet.publicKey).toString('hex'))).toBe(true);
    expect(verifyTonW5Request(read, stranger.publicKey)).toBe(false);
  });

  it('refuses a request whose signed part was changed', () => {
    const changed = [
      request(3, [{ ...messages[0], value: 6n }, messages[1], messages[2]]),
      request(3, [messages[0], { ...messages[1], body: tonJettonTransferBody({ amount: 10_001n, destination: OTHER, responseDestination: wallet.address, forwardTonAmount: 1n }) }, messages[2]]),
      request(2),
      request(3, [...messages, { to: OTHER, value: 1n }]),
    ];
    for (const other of changed) {
      expect(verifyTonW5Request(tonSignedRequestOf(withSignature(other.body, signature)), wallet.publicKey)).toBe(false);
    }
  });

  it('refuses a changed signature', () => {
    const flipped = Buffer.from(signature);
    flipped[10] ^= 1;
    expect(verifyTonW5Request(tonSignedRequestOf(withSignature(body, flipped)), wallet.publicKey)).toBe(false);
  });

  it('throws on a malformed key', () => {
    expect(() => verifyTonW5Request(tonSignedRequestOf(body), 'abc')).toThrow(expect.objectContaining({ kind: ChainErrorKinds.InvalidArgument }));
  });
});

describe('tonW5DefaultWalletId', () => {
  it("is the wallet id TonWallet's W5 signs, on either workchain", () => {
    expect(tonW5DefaultWalletId()).toBe(tonW5RequestFields(request().body).walletId);
    const masterchain = TonWallet.fromMnemonic(MNEMONIC, { workchain: -1 });
    const { body } = masterchain.createInternalRequest({ seqno: 0, validUntil: VALID_UNTIL, messages: [{ to: OTHER, value: 1n }] });
    expect(tonW5DefaultWalletId()).toBe(tonW5RequestFields(body).walletId);
  });
});
