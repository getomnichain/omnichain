import { jest } from '@jest/globals';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';

import { SolanaChain } from '../solana_chain.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

const DUMMY_BLOCKHASH = '11111111111111111111111111111111';

function makeChain(): SolanaChain {
  return new SolanaChain({
    chainId: -1701,
    name: 'SimAccountsTest',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
  });
}

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

async function expectKind(p: Promise<unknown>, kind: (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds]): Promise<void> {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect(isChainError(caught, kind)).toBe(true);
}

const USER = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();

describe('SolanaChain.simulateTransaction — accounts passthrough (0.3.2)', () => {
  it('returns decoded { lamports, data } when opts.accounts is set', async () => {
    const chain = makeChain();
    const raw = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      simulateTransaction: async () => ({
        value: {
          unitsConsumed: 5_000,
          err: null,
          logs: null,
          accounts: [{ lamports: 999_000, data: [raw.toString('base64'), 'base64'] }],
        },
      }),
    });
    const out = await chain.simulateTransaction(buildSignedTx(), { accounts: { addresses: [USER] } });
    expect(out.unitsConsumed).toBe(5_000);
    expect(out.accounts).toBeDefined();
    expect(out.accounts![0]).not.toBeNull();
    expect(out.accounts![0]!.lamports).toBe(999_000);
    expect(Array.from(out.accounts![0]!.data)).toEqual([0x11, 0x22, 0x33, 0x44]);
  });

  it('maps a missing post-sim account to null (preserving input order)', async () => {
    const chain = makeChain();
    const raw = Buffer.from([0xff]);
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      simulateTransaction: async () => ({
        value: {
          unitsConsumed: 0,
          err: null,
          logs: null,
          accounts: [{ lamports: 1, data: [raw.toString('base64'), 'base64'] }, null],
        },
      }),
    });
    const out = await chain.simulateTransaction(buildSignedTx(), { accounts: { addresses: [USER, OTHER] } });
    expect(out.accounts!.length).toBe(2);
    expect(out.accounts![0]!.lamports).toBe(1);
    expect(out.accounts![1]).toBeNull();
  });

  it('omits accounts field in the return when opts.accounts is not supplied (0.3.1 back-compat)', async () => {
    const chain = makeChain();
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      simulateTransaction: async () => ({ value: { unitsConsumed: 1, err: null, logs: null } }),
    });
    const out = await chain.simulateTransaction(buildSignedTx());
    expect(out.accounts).toBeUndefined();
    expect(Object.keys(out).sort()).toEqual(['err', 'logs', 'unitsConsumed']);
  });

  it('forwards the base64 encoding + address list to Connection', async () => {
    const chain = makeChain();
    let receivedOpts: Record<string, unknown> | undefined;
    (chain as unknown as { getConnection(): unknown }).getConnection = () => ({
      simulateTransaction: async (_tx: unknown, o: Record<string, unknown>) => {
        receivedOpts = o;
        return { value: { unitsConsumed: 0, err: null, logs: null, accounts: [null] } };
      },
    });
    await chain.simulateTransaction(buildSignedTx(), { accounts: { addresses: [USER] } });
    const accountsOpt = receivedOpts?.accounts as { encoding: string; addresses: string[] };
    expect(accountsOpt.encoding).toBe('base64');
    expect(accountsOpt.addresses).toEqual([USER]);
  });

  it('rejects empty addresses array as InvalidArgument', async () => {
    await expectKind(
      makeChain().simulateTransaction(buildSignedTx(), { accounts: { addresses: [] } }),
      ChainErrorKinds.InvalidArgument,
    );
  });

  it('rejects a malformed pubkey in addresses as InvalidAddress', async () => {
    await expectKind(
      makeChain().simulateTransaction(buildSignedTx(), { accounts: { addresses: ['not-a-pubkey'] } }),
      ChainErrorKinds.InvalidAddress,
    );
  });
});

jest.setTimeout(10_000);
