import { NetworkType, networkTypeOf } from '../../network_type.ts';
import { SolanaChain } from '../solana_chain.ts';
import {
  ALL_SOLANA_CHAINS,
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_TESTNET_CHAIN_ID,
  SolanaDevnet,
  SolanaMainnet,
  SolanaTestnet,
} from '../solana_chains.ts';

const VALID_ADDR = '5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4';
const VALID_MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // mainnet USDC
const VALID_SIG = '4yu6a7snnRniALjAoTq5mGbsdYaZD5A16WwtbYPPRbkAsmdLrhmtGTwVcx8pFB5zTSVD3HUiFMChNtx6djFB5oEU';

describe('SolanaChain — pre-baked chains', () => {
  it('exposes mainnet/testnet/devnet with the documented negative chainIds', () => {
    expect(SolanaMainnet.chainId).toBe(SOLANA_MAINNET_CHAIN_ID);
    expect(SolanaTestnet.chainId).toBe(SOLANA_TESTNET_CHAIN_ID);
    expect(SolanaDevnet.chainId).toBe(SOLANA_DEVNET_CHAIN_ID);
    expect(ALL_SOLANA_CHAINS).toHaveLength(3);
  });

  it('registers each chainId as NetworkType.SOLANA in the network-type registry', () => {
    // The constructor calls registerNonEvmChain — verify the side effect.
    expect(networkTypeOf(SOLANA_MAINNET_CHAIN_ID)).toBe(NetworkType.SOLANA);
    expect(networkTypeOf(SOLANA_TESTNET_CHAIN_ID)).toBe(NetworkType.SOLANA);
    expect(networkTypeOf(SOLANA_DEVNET_CHAIN_ID)).toBe(NetworkType.SOLANA);
  });

  it('exposes native SOL with 9 decimals and undefined identifier (native)', () => {
    expect(SolanaMainnet.nativeToken.symbol).toBe('SOL');
    expect(SolanaMainnet.nativeToken.decimals).toBe(9);
    expect(SolanaMainnet.nativeToken.identifier).toBeUndefined();
    expect(SolanaMainnet.nativeToken.isNative()).toBe(true);
  });

  it('mainnet explorer URLs have no cluster suffix; testnet/devnet do', () => {
    expect(SolanaMainnet.getWalletExplorerUrl(VALID_ADDR)).toBe(`https://solscan.io/account/${VALID_ADDR}`);
    expect(SolanaTestnet.getWalletExplorerUrl(VALID_ADDR)).toBe(
      `https://solscan.io/account/${VALID_ADDR}?cluster=testnet`,
    );
    expect(SolanaDevnet.getTransactionExplorerUrl(VALID_SIG)).toBe(
      `https://solscan.io/tx/${VALID_SIG}?cluster=devnet`,
    );
    expect(SolanaMainnet.getTokenExplorerUrl(VALID_MINT_USDC)).toBe(
      `https://solscan.io/token/${VALID_MINT_USDC}`,
    );
    expect(SolanaMainnet.getTokenExplorerUrl(undefined)).toBe('https://solscan.io');
  });
});

describe('SolanaChain — validators', () => {
  it('validateAddress accepts valid base58 32-byte addresses', () => {
    expect(SolanaMainnet.validateAddress(VALID_ADDR)).toBe(true);
    expect(SolanaMainnet.validateAddress(VALID_MINT_USDC)).toBe(true);
  });

  it('validateAddress rejects malformed input', () => {
    expect(SolanaMainnet.validateAddress('not-an-address')).toBe(false);
    expect(SolanaMainnet.validateAddress('')).toBe(false);
    // Containing forbidden base58 chars
    expect(SolanaMainnet.validateAddress('0' + VALID_ADDR.slice(1))).toBe(false);
  });

  it('validateTokenIdentifier accepts undefined (native) or a valid mint address', () => {
    expect(SolanaMainnet.validateTokenIdentifier(undefined)).toBe(true);
    expect(SolanaMainnet.validateTokenIdentifier(VALID_MINT_USDC)).toBe(true);
  });

  it('validateTokenIdentifier rejects the magic-string "NATIVE" and malformed mints', () => {
    expect(SolanaMainnet.validateTokenIdentifier('NATIVE')).toBe(false);
    expect(SolanaMainnet.validateTokenIdentifier('not-an-address')).toBe(false);
  });
});

describe('SolanaChain — RPC precedence (constructor > env > defaultRpcUrl)', () => {
  const originalEnv = process.env.SOLANA_RPC_URL;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SOLANA_RPC_URL;
    else process.env.SOLANA_RPC_URL = originalEnv;
  });

  it('constructor rpcUrl wins over env var', () => {
    process.env.SOLANA_RPC_URL = 'https://env.example.invalid';
    const chain = new SolanaChain({
      chainId: -999,
      name: 'Solana Test',
      blockTimeSeconds: 0.4,
      explorerBaseUrl: 'https://solscan.io',
      nativeSymbol: 'SOL',
      defaultRpcUrl: 'https://default.example.invalid',
      rpcUrl: 'https://ctor.example.invalid',
      chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
    });
    expect(chain.getConnection().rpcEndpoint).toBe('https://ctor.example.invalid');
  });

  it('falls back to defaultRpcUrl when neither constructor URL nor env var is set', () => {
    delete process.env.SOLANA_RPC_URL;
    const chain = new SolanaChain({
      chainId: -998,
      name: 'Solana FallbackTest', // no env var of this shape is set
      blockTimeSeconds: 0.4,
      explorerBaseUrl: 'https://solscan.io',
      nativeSymbol: 'SOL',
      defaultRpcUrl: 'https://default.example.invalid',
      chainAgnosticGenesisHash: 'test-genesis-hash-32-chars------',
    });
    expect(chain.getConnection().rpcEndpoint).toBe('https://default.example.invalid');
  });
});
