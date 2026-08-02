import { PublicKey, SystemProgram, SystemInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { SolanaMainnet } from '../solana_chains.ts';

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // classic SPL
const PYUSD_MINT = new PublicKey('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo'); // Token-2022
const ALICE = new PublicKey('5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4');
const BOB = new PublicKey('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');

describe('SolanaChain.buildNativeTransferInstruction', () => {
  it('returns a SystemProgram.transfer instruction with the given lamports', () => {
    const ix = SolanaMainnet.buildNativeTransferInstruction(ALICE, BOB, 12345n);
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    const decoded = SystemInstruction.decodeTransfer(ix);
    expect(decoded.fromPubkey.equals(ALICE)).toBe(true);
    expect(decoded.toPubkey.equals(BOB)).toBe(true);
    expect(decoded.lamports).toBe(12345n);
  });

  it('throws ChainError(InvalidArgument) on zero lamports (no silent no-op)', () => {
    expect(() => SolanaMainnet.buildNativeTransferInstruction(ALICE, BOB, 0n)).toThrow(
      /must be positive/,
    );
  });

  it('throws ChainError(InvalidArgument) on negative lamports', () => {
    expect(() => SolanaMainnet.buildNativeTransferInstruction(ALICE, BOB, -1n)).toThrow(
      /must be positive/,
    );
  });
});

describe('SolanaChain.buildSplTransferInstructions', () => {
  const chain = SolanaMainnet;

  const mockResolveClassic = (): jest.Spied<any>[] => [
    jest.spyOn(chain, 'resolveTokenProgramId').mockResolvedValue(TOKEN_PROGRAM_ID),
    jest.spyOn(chain, 'resolveMintDecimals').mockResolvedValue(6),
  ];
  const mockResolveToken2022 = (): jest.Spied<any>[] => [
    jest.spyOn(chain, 'resolveTokenProgramId').mockResolvedValue(TOKEN_2022_PROGRAM_ID),
    jest.spyOn(chain, 'resolveMintDecimals').mockResolvedValue(6),
  ];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('with defaults returns [createATA-idempotent, transferChecked] — length 2', async () => {
    mockResolveClassic();
    const ixs = await chain.buildSplTransferInstructions({
      from: ALICE,
      to: BOB,
      mint: USDC_MINT,
      amount: 1_000_000n,
    });
    expect(ixs).toHaveLength(2);
    expect(ixs[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[1].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('locks the IDEMPOTENT ATA variant (data byte 1, not the non-idempotent form)', async () => {
    mockResolveClassic();
    const ixs = await chain.buildSplTransferInstructions({
      from: ALICE,
      to: BOB,
      mint: USDC_MINT,
      amount: 1_000_000n,
    });
    // createAssociatedTokenAccountIdempotentInstruction emits data = [1].
    // The non-idempotent createAssociatedTokenAccountInstruction emits empty data.
    // If someone swaps the import back, this assertion breaks.
    expect(Buffer.from(ixs[0].data)).toEqual(Buffer.from([1]));
  });

  it('wires createATA accounts correctly: keys[0]=payer(from), keys[2]=owner(to)', async () => {
    mockResolveClassic();
    const ixs = await chain.buildSplTransferInstructions({
      from: ALICE,
      to: BOB,
      mint: USDC_MINT,
      amount: 1_000_000n,
    });
    const createAta = ixs[0];
    expect(createAta.keys[0].pubkey.equals(ALICE)).toBe(true); // payer = from
    expect(createAta.keys[2].pubkey.equals(BOB)).toBe(true); // owner = to
    expect(createAta.keys[3].pubkey.equals(USDC_MINT)).toBe(true); // mint
  });

  it('with includeCreateAta:false returns only [transferChecked] — length 1', async () => {
    mockResolveClassic();
    const ixs = await chain.buildSplTransferInstructions({
      from: ALICE,
      to: BOB,
      mint: USDC_MINT,
      amount: 1_000_000n,
      includeCreateAta: false,
    });
    expect(ixs).toHaveLength(1);
    expect(ixs[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
  });

  it('with allowOwnerOffCurve:true derives BOTH source and destination ATAs off-curve', async () => {
    mockResolveClassic();
    const pdaFrom = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), ALICE.toBuffer()],
      new PublicKey('11111111111111111111111111111112'),
    )[0];
    const pdaTo = PublicKey.findProgramAddressSync(
      [Buffer.from('recipient'), BOB.toBuffer()],
      new PublicKey('11111111111111111111111111111112'),
    )[0];

    const ixs = await chain.buildSplTransferInstructions({
      from: pdaFrom,
      to: pdaTo,
      mint: USDC_MINT,
      amount: 1n,
      allowOwnerOffCurve: true,
    });

    const expectedSourceAta = getAssociatedTokenAddressSync(USDC_MINT, pdaFrom, true, TOKEN_PROGRAM_ID);
    const expectedDestAta = getAssociatedTokenAddressSync(USDC_MINT, pdaTo, true, TOKEN_PROGRAM_ID);

    const transferChecked = ixs[1];
    const sourceAtaInIx = transferChecked.keys[0].pubkey;
    const destAtaInIx = transferChecked.keys[2].pubkey;
    expect(sourceAtaInIx.equals(expectedSourceAta)).toBe(true);
    expect(destAtaInIx.equals(expectedDestAta)).toBe(true);

    const createAta = ixs[0];
    expect(createAta.keys[1].pubkey.equals(expectedDestAta)).toBe(true);
  });

  it('with allowOwnerOffCurve:false (default) throws ChainError(InvalidAddress) when from is off-curve', async () => {
    mockResolveClassic();
    const pdaFrom = PublicKey.findProgramAddressSync(
      [Buffer.from('vault')],
      new PublicKey('11111111111111111111111111111112'),
    )[0];
    // The wrapper rethrows spl-token's empty-message TokenOwnerOffCurveError
    // as ChainError with a discoverable reason. Assert on that reason so this
    // can't pass silently on an unrelated throw.
    await expect(
      chain.buildSplTransferInstructions({
        from: pdaFrom,
        to: BOB,
        mint: USDC_MINT,
        amount: 1n,
      }),
    ).rejects.toThrow(/source owner is off-curve/);
  });

  it('throws ChainError(InvalidArgument) on zero amount (no silent no-op transfer)', async () => {
    mockResolveClassic();
    await expect(
      chain.buildSplTransferInstructions({
        from: ALICE,
        to: BOB,
        mint: USDC_MINT,
        amount: 0n,
      }),
    ).rejects.toThrow(/must be positive/);
  });

  it('throws ChainError(InvalidArgument) on negative amount', async () => {
    mockResolveClassic();
    await expect(
      chain.buildSplTransferInstructions({
        from: ALICE,
        to: BOB,
        mint: USDC_MINT,
        amount: -1n,
      }),
    ).rejects.toThrow(/must be positive/);
  });

  it('routes a Token-2022 mint through TOKEN_2022_PROGRAM_ID end-to-end', async () => {
    mockResolveToken2022();
    const ixs = await chain.buildSplTransferInstructions({
      from: ALICE,
      to: BOB,
      mint: PYUSD_MINT,
      amount: 1n,
    });
    expect(ixs).toHaveLength(2);
    // createATA carries the token program id at keys[5] (payer, ata, owner, mint, systemProgram, tokenProgram)
    expect(ixs[0].keys[5].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(ixs[1].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    const expectedSource = getAssociatedTokenAddressSync(PYUSD_MINT, ALICE, false, TOKEN_2022_PROGRAM_ID);
    expect(ixs[1].keys[0].pubkey.equals(expectedSource)).toBe(true);
  });
});
