import { ChainErrorKinds, isChainError } from '../../errors.ts';
import {
  AssetBalanceChange,
  NestedBalanceChanges,
  TransactionStatusTypes,
  assetHashOf,
  isSuccess,
} from '../../transaction_status.ts';
import { SolanaAddress } from '../solana_address.ts';
import { SolanaToken } from '../solana_token.ts';
import { CHAIN_ID_SOLANA_MAINNET as SOLANA_MAINNET_CHAIN_ID } from '../../chain_ids.ts';
import {
  SolanaTransactionFees,
  SolanaTransactionStatus,
} from '../solana_transaction_status.ts';

// Same load-time skip as decode_balance_changes.spec — SolanaAddress
// construction can't validate under a stubbed @solana/web3.js.
const web3StubbedInEnv = ((): boolean => {
  try {
    new SolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    return false;
  } catch {
    return true;
  }
})();
const maybeDescribe = web3StubbedInEnv ? describe.skip : describe;

const FEE_PAYER = '5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4';
const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function makeFees(opts?: Partial<{ feeLamports: bigint }>): SolanaTransactionFees {
  return new SolanaTransactionFees({
    feePayer: FEE_PAYER,
    feeLamports: opts?.feeLamports ?? 5000n,
    computeUnitsConsumed: 1000n,
    netLamportsChangeByFeePayer: -5000n,
  });
}

function nativeToken(): SolanaToken {
  return SolanaToken.native(SOLANA_MAINNET_CHAIN_ID, 'SOL', 9);
}

maybeDescribe('SolanaTransactionStatus.balanceChangesExcludingFees', () => {
  it('happy path: fee_payer already has native row → credit strips the fee debit', () => {
    const bc: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(bc, FEE_PAYER, nativeToken(), AssetBalanceChange.fromMr(-5000n, 9));
    AssetBalanceChange.upsert(bc, OTHER, nativeToken(), AssetBalanceChange.fromMr(1_000_000n, 9));
    const s = SolanaTransactionStatus.successful({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      balanceChanges: bc,
      fees: makeFees(),
    });
    const out = s.balanceChangesExcludingFees(nativeToken());
    // Fee-payer's -5000 debit cancelled by +5000 credit → row deleted (zero-net).
    expect(out.has(FEE_PAYER)).toBe(false);
    expect(out.get(OTHER)?.size).toBe(1);
  });

  it('fee_payer row absent → creates a fresh +feeLamports credit', () => {
    const bc: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(bc, OTHER, nativeToken(), AssetBalanceChange.fromMr(-1000n, 9));
    const s = SolanaTransactionStatus.successful({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      balanceChanges: bc,
      fees: makeFees({ feeLamports: 5000n }),
    });
    const out = s.balanceChangesExcludingFees(nativeToken());
    const payerEntry = [...out.get(FEE_PAYER)!.values()][0];
    expect(payerEntry.change.balanceChangeMr).toBe(5000n);
  });

  it('feeLamports === 0n and fee_payer row absent → no phantom zero row', () => {
    const bc: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(bc, OTHER, nativeToken(), AssetBalanceChange.fromMr(-1n, 9));
    const s = SolanaTransactionStatus.successful({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      balanceChanges: bc,
      fees: makeFees({ feeLamports: 0n }),
    });
    const out = s.balanceChangesExcludingFees(nativeToken());
    expect(out.has(FEE_PAYER)).toBe(false);
  });

  it('nativeAsset with wrong chainId throws InvalidArgument (no phantom row)', () => {
    const bc: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(bc, FEE_PAYER, nativeToken(), AssetBalanceChange.fromMr(-5000n, 9));
    const s = SolanaTransactionStatus.successful({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      balanceChanges: bc,
      fees: makeFees(),
    });
    const foreign = SolanaToken.native(1, 'ETH', 18);
    try {
      s.balanceChangesExcludingFees(foreign);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('nativeAsset with non-empty identifier throws InvalidArgument', () => {
    const bc: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(bc, FEE_PAYER, nativeToken(), AssetBalanceChange.fromMr(-5000n, 9));
    const s = SolanaTransactionStatus.successful({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      balanceChanges: bc,
      fees: makeFees(),
    });
    const notNative = new SolanaToken(SOLANA_MAINNET_CHAIN_ID, 'USDC', USDC_MINT, 6);
    try {
      s.balanceChangesExcludingFees(notNative);
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('balanceChanges === null throws InvalidArgument', () => {
    const s = SolanaTransactionStatus.pending(SOLANA_MAINNET_CHAIN_ID);
    try {
      s.balanceChangesExcludingFees(nativeToken());
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('fees === null throws InvalidArgument (settled-but-unfetchable failed path)', () => {
    const s = SolanaTransactionStatus.failed({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      error: { code: 'REVERTED' },
      fees: null,
    });
    try {
      s.balanceChangesExcludingFees(nativeToken());
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('deep-copy independence: mutating the returned map must not affect this.balanceChanges', () => {
    const bc: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(bc, OTHER, nativeToken(), AssetBalanceChange.fromMr(1_000_000n, 9));
    AssetBalanceChange.upsert(bc, FEE_PAYER, nativeToken(), AssetBalanceChange.fromMr(-5000n, 9));
    const s = SolanaTransactionStatus.successful({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      balanceChanges: bc,
      fees: makeFees(),
    });
    const out = s.balanceChangesExcludingFees(nativeToken());
    // Mutate the copy: add a new row for OTHER
    AssetBalanceChange.upsert(out, OTHER, nativeToken(), AssetBalanceChange.fromMr(999n, 9));
    // Original should still show OTHER's row untouched
    const origOtherEntry = [...s.balanceChanges!.get(OTHER)!.values()][0];
    expect(origOtherEntry.change.balanceChangeMr).toBe(1_000_000n);
  });

  it('preserves the asset-hash key convention on the fresh row', () => {
    const bc: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(bc, OTHER, nativeToken(), AssetBalanceChange.fromMr(-1n, 9));
    const s = SolanaTransactionStatus.successful({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      balanceChanges: bc,
      fees: makeFees(),
    });
    const out = s.balanceChangesExcludingFees(nativeToken());
    const feePayerRow = out.get(FEE_PAYER);
    expect(feePayerRow?.has(assetHashOf(nativeToken()))).toBe(true);
  });

  // Note: isSuccess is imported to silence unused-warning; also documents
  // the type-guard is exported from the base module.
  it('is a Success by construction', () => {
    const bc: NestedBalanceChanges = new Map();
    AssetBalanceChange.upsert(bc, FEE_PAYER, nativeToken(), AssetBalanceChange.fromMr(-5000n, 9));
    const s = SolanaTransactionStatus.successful({
      chainId: SOLANA_MAINNET_CHAIN_ID,
      inclusionAt: null,
      balanceChanges: bc,
      fees: makeFees(),
    });
    expect(s.status).toBe(TransactionStatusTypes.Success);
    expect(isSuccess(s)).toBe(true);
  });
});
