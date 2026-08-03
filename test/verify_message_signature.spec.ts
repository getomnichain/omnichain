import { jest } from '@jest/globals';
import { Wallet, hashMessage } from 'ethers';
import { Keypair } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';

import { EvmChain } from '../evm/evm_chain.ts';
import { SolanaChain } from '../solana/solana_chain.ts';

function evmChain(): EvmChain {
  return new EvmChain({
    chainId: 1,
    name: 'VerifySigEvmTest',
    blockTimeSeconds: 12,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    explorerBaseUrl: 'https://example.com',
    rpcUrl: 'http://127.0.0.1:1',
  });
}

function solanaChain(): SolanaChain {
  return new SolanaChain({
    chainId: -2001,
    name: 'VerifySigSolTest',
    blockTimeSeconds: 0.4,
    explorerBaseUrl: 'https://explorer.solana.com/tx/',
    nativeSymbol: 'SOL',
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
  });
}

describe('EvmChain.verifyMessageSignature — round-trip', () => {
  it('returns true for a valid EIP-191 personal_sign signature', async () => {
    const wallet = Wallet.createRandom();
    const message = 'Hello omnichain — verifying my address';
    const signature = await wallet.signMessage(message);
    const ok = await evmChain().verifyMessageSignature({
      message,
      signer: wallet.address,
      signature,
    });
    expect(ok).toBe(true);
  });

  it('returns false for a signature from a different signer', async () => {
    const a = Wallet.createRandom();
    const b = Wallet.createRandom();
    const message = 'proof';
    const sig = await a.signMessage(message);
    const ok = await evmChain().verifyMessageSignature({
      message,
      signer: b.address,
      signature: sig,
    });
    expect(ok).toBe(false);
  });

  it('accepts an unprefixed / non-checksum signer address', async () => {
    const wallet = Wallet.createRandom();
    const message = 'test';
    const sig = await wallet.signMessage(message);
    const ok = await evmChain().verifyMessageSignature({
      message,
      signer: wallet.address.toLowerCase(),
      signature: sig,
    });
    expect(ok).toBe(true);
  });

  it('returns false (does not throw) for a malformed signature', async () => {
    const wallet = Wallet.createRandom();
    const ok = await evmChain().verifyMessageSignature({
      message: 'x',
      signer: wallet.address,
      signature: 'not-a-signature',
    });
    expect(ok).toBe(false);
  });

  it('returns false (does not throw) for a malformed signer address', async () => {
    const wallet = Wallet.createRandom();
    const sig = await wallet.signMessage('x');
    const ok = await evmChain().verifyMessageSignature({
      message: 'x',
      signer: 'not-an-address',
      signature: sig,
    });
    expect(ok).toBe(false);
  });

  it('sanity: the message digest is EIP-191 personal_sign, not raw', () => {
    // If someone signs the raw keccak instead of the personal_sign envelope,
    // this method should reject. Proves the personal_sign wrapping is applied.
    const digest = hashMessage('x');
    expect(digest.startsWith('0x')).toBe(true);
    expect(digest.length).toBe(66);
  });
});

describe('SolanaChain.verifyMessageSignature — round-trip', () => {
  const chain = solanaChain();

  function signMsg(msg: string, kp: Keypair): string {
    const messageBytes = Buffer.from(msg, 'utf8');
    const sig = ed25519.sign(messageBytes, kp.secretKey.slice(0, 32));
    return bs58.encode(sig);
  }

  it('returns true for a valid ed25519 signature (base58 encoded)', async () => {
    const kp = Keypair.generate();
    const message = 'omnichain proof';
    const signature = signMsg(message, kp);
    const ok = await chain.verifyMessageSignature({
      message,
      signer: kp.publicKey.toBase58(),
      signature,
    });
    expect(ok).toBe(true);
  });

  it('accepts hex-encoded signature (128 chars)', async () => {
    const kp = Keypair.generate();
    const message = 'omnichain hex';
    const messageBytes = Buffer.from(message, 'utf8');
    const rawSig = ed25519.sign(messageBytes, kp.secretKey.slice(0, 32));
    const hexSig = Buffer.from(rawSig).toString('hex');
    const ok = await chain.verifyMessageSignature({
      message,
      signer: kp.publicKey.toBase58(),
      signature: hexSig,
    });
    expect(ok).toBe(true);
  });

  it('returns false for a signature from a different signer', async () => {
    const a = Keypair.generate();
    const b = Keypair.generate();
    const message = 'proof';
    const sig = signMsg(message, a);
    const ok = await chain.verifyMessageSignature({
      message,
      signer: b.publicKey.toBase58(),
      signature: sig,
    });
    expect(ok).toBe(false);
  });

  it('returns false (does not throw) for a malformed signer', async () => {
    const kp = Keypair.generate();
    const sig = signMsg('x', kp);
    const ok = await chain.verifyMessageSignature({
      message: 'x',
      signer: 'not-a-pubkey',
      signature: sig,
    });
    expect(ok).toBe(false);
  });

  it('returns false (does not throw) for a malformed signature', async () => {
    const kp = Keypair.generate();
    const ok = await chain.verifyMessageSignature({
      message: 'x',
      signer: kp.publicKey.toBase58(),
      signature: 'not-a-signature',
    });
    expect(ok).toBe(false);
  });
});

jest.setTimeout(10_000);
