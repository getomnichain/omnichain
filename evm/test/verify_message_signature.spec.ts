import { Wallet, getAddress } from 'ethers';

import { Arbitrum } from '../evm_chains.ts';

describe('EvmChain.verifyMessageSignature', () => {
  const message = 'Pluton login nonce 7f3a2c91';
  const wallet = new Wallet('0x' + 'aa'.repeat(32));

  it('returns true for a valid signature', async () => {
    const signature = await wallet.signMessage(message);
    const ok = await Arbitrum.verifyMessageSignature({
      message,
      signer: wallet.address,
      signature,
    });
    expect(ok).toBe(true);
  });

  it('accepts the signer in lowercase form', async () => {
    const signature = await wallet.signMessage(message);
    const ok = await Arbitrum.verifyMessageSignature({
      message,
      signer: wallet.address.toLowerCase(),
      signature,
    });
    expect(ok).toBe(true);
  });

  it('returns false when the message differs', async () => {
    const signature = await wallet.signMessage(message);
    const ok = await Arbitrum.verifyMessageSignature({
      message: message + ' tampered',
      signer: wallet.address,
      signature,
    });
    expect(ok).toBe(false);
  });

  it('returns false when the signer differs', async () => {
    const signature = await wallet.signMessage(message);
    const other = new Wallet('0x' + 'bb'.repeat(32));
    const ok = await Arbitrum.verifyMessageSignature({
      message,
      signer: other.address,
      signature,
    });
    expect(ok).toBe(false);
  });

  it('returns false for a malformed signature', async () => {
    const ok = await Arbitrum.verifyMessageSignature({
      message,
      signer: wallet.address,
      signature: '0xdeadbeef',
    });
    expect(ok).toBe(false);
  });

  it('returns false for a malformed signer', async () => {
    const signature = await wallet.signMessage(message);
    const ok = await Arbitrum.verifyMessageSignature({
      message,
      signer: 'not-an-address',
      signature,
    });
    expect(ok).toBe(false);
  });

  it('round-trips through getAddress checksum form', async () => {
    const signature = await wallet.signMessage(message);
    const ok = await Arbitrum.verifyMessageSignature({
      message,
      signer: getAddress(wallet.address),
      signature,
    });
    expect(ok).toBe(true);
  });
});
