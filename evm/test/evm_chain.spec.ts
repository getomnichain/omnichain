import { ARBITRUM_CHAIN_ID, Arbitrum } from '../evm_chains.ts';
import { EvmChain } from '../evm_chain.ts';
import { ARBITRUM_USDC } from '../evm_tokens.ts';
import { ChainErrorKinds, isChainError } from '../../errors.ts';

const VALID_EIP55 = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const VALID_LOWERCASE = '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed';
const BAD_CHECKSUM = '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('EvmChain — predefined chains', () => {
  it('Arbitrum has correct id, name, blockTimeSeconds, explorer', () => {
    expect(Arbitrum.chainId).toBe(ARBITRUM_CHAIN_ID);
    expect(Arbitrum.name).toBe('Arbitrum');
    expect(Arbitrum.blockTimeSeconds).toBe(0.25);
    expect(Arbitrum.explorerBaseUrl).toBe('https://arbiscan.io');
  });

  it('exposes native ETH token with identifier=undefined', () => {
    expect(Arbitrum.nativeToken.symbol).toBe('ETH');
    expect(Arbitrum.nativeToken.identifier).toBeUndefined();
    expect(Arbitrum.nativeToken.decimals).toBe(18);
    expect(Arbitrum.nativeToken.isNative()).toBe(true);
  });
});

describe('EvmChain — explorer URLs', () => {
  it('wallet URL is /address/<addr>', () => {
    expect(Arbitrum.getWalletExplorerUrl(VALID_EIP55)).toBe(
      `https://arbiscan.io/address/${VALID_EIP55}`
    );
  });

  it('token URL is /token/<addr> for ERC20 and base URL for native (undefined)', () => {
    expect(Arbitrum.getTokenExplorerUrl(ARBITRUM_USDC.identifier)).toContain('/token/');
    expect(Arbitrum.getTokenExplorerUrl(undefined)).toBe('https://arbiscan.io');
  });

  it('transaction URL is /tx/<hash> and prepends 0x if missing', () => {
    expect(Arbitrum.getTransactionExplorerUrl('abc')).toBe('https://arbiscan.io/tx/0xabc');
    expect(Arbitrum.getTransactionExplorerUrl('0xabc')).toBe('https://arbiscan.io/tx/0xabc');
  });
});

describe('EvmChain — validators', () => {
  it('validateAddress accepts EIP-55 + all-lowercase', () => {
    expect(Arbitrum.validateAddress(VALID_EIP55)).toBe(true);
    expect(Arbitrum.validateAddress(VALID_LOWERCASE)).toBe(true);
  });

  it('validateAddress rejects bad checksum, wrong length, non-hex', () => {
    expect(Arbitrum.validateAddress(BAD_CHECKSUM)).toBe(false);
    expect(Arbitrum.validateAddress('0x123')).toBe(false);
    expect(Arbitrum.validateAddress('not-an-address')).toBe(false);
  });

  it('validateTokenIdentifier accepts undefined (native) or a valid address', () => {
    expect(Arbitrum.validateTokenIdentifier(undefined)).toBe(true);
    expect(Arbitrum.validateTokenIdentifier(VALID_EIP55)).toBe(true);
  });

  it('validateTokenIdentifier rejects the string "NATIVE" / "native" / "Native"', () => {
    expect(Arbitrum.validateTokenIdentifier('NATIVE')).toBe(false);
    expect(Arbitrum.validateTokenIdentifier('native')).toBe(false);
    expect(Arbitrum.validateTokenIdentifier('Native')).toBe(false);
    expect(Arbitrum.validateTokenIdentifier('not-an-address')).toBe(false);
  });
});

describe('EvmChain — createTransferUnsignedTransaction', () => {
  it('native transfer: to=recipient, value=amount, data="0x", from optional', async () => {
    const tx = await Arbitrum.createTransferUnsignedTransaction({
      to: VALID_EIP55,
      amount: 1_000_000n,
    });
    expect(tx.to.toLowerCase()).toBe(VALID_EIP55.toLowerCase());
    expect(tx.value).toBe(1_000_000n);
    expect(tx.data).toBe('0x');
    expect(tx.from).toBeUndefined();
  });

  it('ERC20 transfer: to=tokenAddress, value=0n, data starts with 0xa9059cbb', async () => {
    const tx = await Arbitrum.createTransferUnsignedTransaction({
      from: VALID_EIP55,
      to: VALID_EIP55,
      tokenIdentifier: ARBITRUM_USDC.identifier,
      amount: 1_000_000n,
    });
    expect(tx.to.toLowerCase()).toBe(ARBITRUM_USDC.identifier!.toLowerCase());
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith('0xa9059cbb')).toBe(true);
  });

  it('rejects invalid recipient', async () => {
    await expect(
      Arbitrum.createTransferUnsignedTransaction({
        to: 'not-an-address',
        amount: 1n,
      })
    ).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidAddress });
  });

  it('rejects invalid token identifier (the string "NATIVE")', async () => {
    await expect(
      Arbitrum.createTransferUnsignedTransaction({
        to: VALID_EIP55,
        tokenIdentifier: 'NATIVE',
        amount: 1n,
      })
    ).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidTokenIdentifier });
  });
});

describe('EvmChain — RPC URL resolution', () => {
  const originalName = process.env.ARBITRUM_RPC_URL;
  const originalId = process.env.EVM_42161_RPC_URL;
  afterEach(() => {
    if (originalName === undefined) delete process.env.ARBITRUM_RPC_URL;
    else process.env.ARBITRUM_RPC_URL = originalName;
    if (originalId === undefined) delete process.env.EVM_42161_RPC_URL;
    else process.env.EVM_42161_RPC_URL = originalId;
  });

  it('getBalance throws RpcNotConfigured when no URL source is set', async () => {
    delete process.env.ARBITRUM_RPC_URL;
    delete process.env.EVM_42161_RPC_URL;
    try {
      await Arbitrum.getBalance(VALID_EIP55);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.RpcNotConfigured)).toBe(true);
    }
  });

  it('constructor rpcUrl wins over env vars', () => {
    process.env.ARBITRUM_RPC_URL = 'https://env-primary.invalid';
    process.env.EVM_42161_RPC_URL = 'https://env-secondary.invalid';
    const chain = new EvmChain({
      chainId: ARBITRUM_CHAIN_ID,
      name: 'Arbitrum',
      blockTimeSeconds: 0.25,
      explorerBaseUrl: 'https://arbiscan.io',
      nativeSymbol: 'ETH',
      rpcUrl: 'https://ctor.invalid',
    });
    // Fresh instance — getProvider caches after first call, so the chain-level
    // rpcUrl field is what we assert.
    expect(chain.rpcUrl).toBe('https://ctor.invalid');
  });

  it('falls back to EVM_<chainId>_RPC_URL when <NAME>_RPC_URL is unset', async () => {
    delete process.env.ARBITRUM_RPC_URL;
    process.env.EVM_42161_RPC_URL = 'https://per-id-fallback.invalid';
    // Fresh instance to bypass the cached provider on the predefined Arbitrum.
    const chain = new EvmChain({
      chainId: ARBITRUM_CHAIN_ID,
      name: 'Arbitrum',
      blockTimeSeconds: 0.25,
      explorerBaseUrl: 'https://arbiscan.io',
      nativeSymbol: 'ETH',
    });
    // getBalance would try to make an actual RPC call; skip that. Instead trigger
    // the URL resolution path indirectly via getProvider which reads and caches it.
    expect(() => chain.getProvider()).not.toThrow();
  });
});
