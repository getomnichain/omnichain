import { jest } from '@jest/globals';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';

import { SolanaChain } from '../solana_chain.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

function makeChain(): SolanaChain {
  return new SolanaChain({
    chainId: -1601,
    name: 'ReadPrimitivesTest',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
  });
}

async function expectKind(p: Promise<unknown>, kind: (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds]): Promise<void> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(isChainError(caught, kind)).toBe(true);
}

describe('SolanaChain.getLatestBlockhash', () => {
  it('returns { blockhash, lastValidBlockHeight } from Connection', async () => {
    const chain = makeChain();
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      getLatestBlockhash: async () => ({ blockhash: 'ABCxyz1111111111111111111111111111', lastValidBlockHeight: 12345 }),
    });
    const out = await chain.getLatestBlockhash();
    expect(out).toEqual({ blockhash: 'ABCxyz1111111111111111111111111111', lastValidBlockHeight: 12345 });
  });

  it('defaults to confirmed commitment', async () => {
    const chain = makeChain();
    let calledWith: string | undefined;
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      getLatestBlockhash: async (c: string) => { calledWith = c; return { blockhash: 'x', lastValidBlockHeight: 1 }; },
    });
    await chain.getLatestBlockhash();
    expect(calledWith).toBe('confirmed');
  });

  it('forwards processed commitment when passed', async () => {
    const chain = makeChain();
    let calledWith: string | undefined;
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      getLatestBlockhash: async (c: string) => { calledWith = c; return { blockhash: 'x', lastValidBlockHeight: 1 }; },
    });
    await chain.getLatestBlockhash('processed');
    expect(calledWith).toBe('processed');
  });

  it('wraps transport failure as ChainError(RpcError), no key leak', async () => {
    const chain = makeChain();
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      getLatestBlockhash: async () => { throw new Error('FetchError: request to https://mainnet.helius-rpc.com/?api-key=SECRETVALUE failed'); },
    });
    let caught: unknown;
    try { await chain.getLatestBlockhash(); } catch (e) { caught = e; }
    expect(isChainError(caught, ChainErrorKinds.RpcError)).toBe(true);
    expect(String(caught)).not.toContain('SECRETVALUE');
  });
});

describe('SolanaChain.simulateTransaction', () => {
  const DUMMY_BLOCKHASH = '11111111111111111111111111111111';
  function buildSignedTx(): Uint8Array {
    const kp = Keypair.generate();
    const ix = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: kp.publicKey, lamports: 1 });
    const message = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: DUMMY_BLOCKHASH,
      instructions: [ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const sig = ed25519.sign(message.serialize(), kp.secretKey.slice(0, 32));
    tx.addSignature(kp.publicKey, sig);
    return tx.serialize();
  }

  it('returns normalized { unitsConsumed, err, logs }', async () => {
    const chain = makeChain();
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      simulateTransaction: async () => ({ value: { unitsConsumed: 12_345, err: null, logs: ['Program A invoke', 'Program A success'] } }),
    });
    const out = await chain.simulateTransaction(buildSignedTx());
    expect(out).toEqual({ unitsConsumed: 12_345, err: null, logs: ['Program A invoke', 'Program A success'] });
  });

  it('forwards replaceRecentBlockhash and commitment opts', async () => {
    const chain = makeChain();
    let received: Record<string, unknown> | undefined;
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      simulateTransaction: async (_tx: unknown, o: Record<string, unknown>) => { received = o; return { value: { unitsConsumed: 0, err: null, logs: null } }; },
    });
    await chain.simulateTransaction(buildSignedTx(), { replaceRecentBlockhash: true, commitment: 'processed', sigVerify: false });
    expect(received?.replaceRecentBlockhash).toBe(true);
    expect(received?.commitment).toBe('processed');
    expect(received?.sigVerify).toBe(false);
  });

  it('accepts hex-string input', async () => {
    const chain = makeChain();
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      simulateTransaction: async () => ({ value: { unitsConsumed: 100, err: null, logs: null } }),
    });
    const bytes = buildSignedTx();
    const hex = '0x' + Buffer.from(bytes).toString('hex');
    const out = await chain.simulateTransaction(hex);
    expect(out.unitsConsumed).toBe(100);
  });

  it('rejects empty Uint8Array as InvalidArgument', async () => {
    await expectKind(makeChain().simulateTransaction(new Uint8Array(0)), ChainErrorKinds.InvalidArgument);
  });

  it('rejects sub-65-byte Uint8Array as InvalidArgument', async () => {
    await expectKind(makeChain().simulateTransaction(new Uint8Array(32)), ChainErrorKinds.InvalidArgument);
  });

  it('rejects malformed hex string as InvalidArgument', async () => {
    await expectKind(makeChain().simulateTransaction('not-hex'), ChainErrorKinds.InvalidArgument);
  });

  it('rejects unparseable-but-well-sized bytes as InvalidArgument', async () => {
    const bogus = new Uint8Array(200);
    for (let i = 0; i < 200; i++) bogus[i] = 0xff;
    await expectKind(makeChain().simulateTransaction(bogus), ChainErrorKinds.InvalidArgument);
  });

  it('wraps transport failure as ChainError(RpcError), no key leak', async () => {
    const chain = makeChain();
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      simulateTransaction: async () => { throw new Error('FetchError: https://x.helius-rpc.com/?api-key=SECRETVALUE'); },
    });
    let caught: unknown;
    try { await chain.simulateTransaction(buildSignedTx()); } catch (e) { caught = e; }
    expect(isChainError(caught, ChainErrorKinds.RpcError)).toBe(true);
    expect(String(caught)).not.toContain('SECRETVALUE');
  });
});

jest.setTimeout(10_000);
