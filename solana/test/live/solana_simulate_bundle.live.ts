import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

import { ChainError, ChainErrorKinds, isChainError } from '../../../errors.ts';
import { SolanaChain } from '../../solana_chain.ts';

const ENV_FILE = new URL('../../../.env.solana.local', import.meta.url);
if (existsSync(ENV_FILE)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(ENV_FILE, 'utf8')))) {
    process.env[name] ??= value;
  }
}

const BUNDLE_RPC_URL = process.env.SOLANA_LIVE_BUNDLE_RPC_URL || 'https://solana-rpc.publicnode.com';
const ANKR_RPC_URL = process.env.SOLANA_LIVE_ANKR_RPC_URL ?? '';
const MAINNET_BETA_URL = 'https://api.mainnet-beta.solana.com';
const FUNDER = new PublicKey(process.env.SOLANA_LIVE_FUNDER || '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const FUNDED_LAMPORTS = 5_000_000;
const FEE_LAMPORTS = 5_000;

function chainAt(rpcUrl: string): SolanaChain {
  return new SolanaChain({
    chainId: -2000,
    name: 'Solana Mainnet (live simulateBundle)',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://solscan.io',
    nativeSymbol: 'SOL',
    defaultRpcUrl: MAINNET_BETA_URL,
    chainAgnosticGenesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    rpcUrl,
  });
}

function unsigned(payer: PublicKey, blockhash: string, instructions: TransactionInstruction[]): Uint8Array {
  return new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(),
  ).serialize();
}

const fund = (wallet: PublicKey, blockhash: string) =>
  unsigned(FUNDER, blockhash, [SystemProgram.transfer({ fromPubkey: FUNDER, toPubkey: wallet, lamports: FUNDED_LAMPORTS })]);

const memo = (payer: PublicKey, blockhash: string, text: string) =>
  unsigned(payer, blockhash, [new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text) })]);

const spend = (wallet: PublicKey, blockhash: string, lamports: number) =>
  unsigned(wallet, blockhash, [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports })]);

async function rejection(promise: Promise<unknown>): Promise<ChainError> {
  try {
    await promise;
  } catch (err) {
    if (isChainError(err)) return err;
    throw err;
  }
  throw new Error('expected a ChainError');
}

describe('SolanaChain.simulateBundle on mainnet', () => {
  const chain = chainAt(BUNDLE_RPC_URL);
  let blockhash: string;

  beforeAll(async () => {
    ({ blockhash } = await chain.getLatestBlockhash('confirmed'));
  });

  it('funds an empty wallet and lets it pay for the next transaction', async () => {
    const wallet = Keypair.generate().publicKey;

    const result = await chain.simulateBundle([fund(wallet, blockhash), memo(wallet, blockhash, 'omnichain simulateBundle')], {
      postAccounts: [null, [wallet.toBase58()]],
    });

    expect(result.succeeded).toBe(true);
    expect(result.failedIndex).toBeNull();
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[1].postAccounts[0]?.lamports).toBe(FUNDED_LAMPORTS - FEE_LAMPORTS);
  });

  it('names the failing transaction and returns no results after it', async () => {
    const wallet = Keypair.generate().publicKey;

    const result = await chain.simulateBundle([
      fund(wallet, blockhash),
      spend(wallet, blockhash, FUNDED_LAMPORTS * 2),
      memo(wallet, blockhash, 'never reached'),
    ]);

    expect(result.succeeded).toBe(false);
    expect(result.failedIndex).toBe(1);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[1].err).not.toBeNull();
    expect(result.error).toEqual(expect.any(String));
  });

  it('returns a stale blockhash as a failed simulation', async () => {
    const result = await chain.simulateBundle([fund(Keypair.generate().publicKey, '11111111111111111111111111111111')]);

    expect(result.succeeded).toBe(false);
    expect(result.failedIndex).toBe(0);
    expect(result.transactions[0].err).toBe('BlockhashNotFound');
  });

  it('throws FeatureNotSupported on api.mainnet-beta.solana.com', async () => {
    const err = await rejection(chainAt(MAINNET_BETA_URL).simulateBundle([fund(Keypair.generate().publicKey, blockhash)]));

    expect(err.kind).toBe(ChainErrorKinds.FeatureNotSupported);
  });

  (ANKR_RPC_URL ? it : it.skip)('throws FeatureNotSupported on keyed Ankr, without the key, while simulateTransaction works there', async () => {
    const ankr = chainAt(ANKR_RPC_URL);
    const tx = fund(Keypair.generate().publicKey, blockhash);

    const err = await rejection(ankr.simulateBundle([tx]));
    const single = await ankr.simulateTransaction(tx);

    expect(err.kind).toBe(ChainErrorKinds.FeatureNotSupported);
    expect(err.message).not.toContain(new URL(ANKR_RPC_URL).pathname.split('/').pop());
    expect(single.err).toBeNull();
  });
});
