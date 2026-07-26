import { TransactionReceipt } from 'ethers';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { AssetBalanceChangeEntry, assetHashOf } from '../../transaction_status.ts';
import { Arbitrum } from '../evm_chains.ts';
import { ARBITRUM_USDC } from '../evm_tokens.ts';

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ADDR_SENDER = '0x1111111111111111111111111111111111111111';
const ADDR_RECIPIENT = '0x2222222222222222222222222222222222222222';

function addrTopic(addr: string): string {
  return `0x000000000000000000000000${addr.replace(/^0x/, '').toLowerCase()}`;
}

function amountData(amount: bigint): string {
  return '0x' + amount.toString(16).padStart(64, '0');
}

function syntheticReceipt(opts: {
  hash?: string;
  status?: number;
  logs?: Array<{ address: string; topics: string[]; data: string }>;
}): TransactionReceipt {
  return {
    hash: opts.hash ?? '0xtx',
    status: opts.status ?? 1,
    blockNumber: 100,
    gasUsed: 21000n,
    gasPrice: 1_000_000_000n,
    from: ADDR_SENDER,
    to: ADDR_RECIPIENT,
    logs: opts.logs ?? [],
  } as unknown as TransactionReceipt;
}

function decode(args: {
  from: string;
  to: string | null;
  value: bigint;
  gasCost?: bigint;
  receipt: TransactionReceipt;
}) {
  return Arbitrum.decodeBalanceChanges({
    from: args.from,
    to: args.to,
    value: args.value,
    gasCost: args.gasCost ?? 0n,
    receipt: args.receipt,
  });
}

function entryFor(
  bc: Map<string, Map<string, AssetBalanceChangeEntry>>,
  wallet: string,
  tokenIdentifier: string | undefined,
): AssetBalanceChangeEntry | undefined {
  const inner = bc.get(wallet.toLowerCase());
  if (!inner) return undefined;
  for (const entry of inner.values()) {
    const id = entry.token.identifier;
    if ((tokenIdentifier ?? undefined) === (id ?? undefined)) return entry;
    if (
      tokenIdentifier !== undefined &&
      id !== undefined &&
      id.toLowerCase() === tokenIdentifier.toLowerCase()
    ) {
      return entry;
    }
  }
  return undefined;
}

describe('EvmChain.decodeBalanceChanges (NestedBalanceChanges shape)', () => {
  it('native-only transfer with zero gasCost yields the transfer as offsetting entries', async () => {
    const bc = await decode({
      from: ADDR_SENDER,
      to: ADDR_RECIPIENT,
      value: 1_000_000n,
      gasCost: 0n,
      receipt: syntheticReceipt({}),
    });
    expect(bc.size).toBe(2);
    expect(entryFor(bc, ADDR_SENDER, undefined)?.change.balanceChangeMr).toBe(-1_000_000n);
    expect(entryFor(bc, ADDR_RECIPIENT, undefined)?.change.balanceChangeMr).toBe(1_000_000n);
  });

  it('native transfer with gasCost debits sender by value+gasCost (Python fee-inclusive semantics)', async () => {
    const bc = await decode({
      from: ADDR_SENDER,
      to: ADDR_RECIPIENT,
      value: 1_000_000n,
      gasCost: 21_000_000_000_000n,
      receipt: syntheticReceipt({}),
    });
    expect(entryFor(bc, ADDR_SENDER, undefined)?.change.balanceChangeMr).toBe(
      -(1_000_000n + 21_000_000_000_000n),
    );
    expect(entryFor(bc, ADDR_RECIPIENT, undefined)?.change.balanceChangeMr).toBe(1_000_000n);
  });

  it('self-transfer nets to only -gasCost on sender (no phantom -value)', async () => {
    const bc = await decode({
      from: ADDR_SENDER,
      to: ADDR_SENDER,
      value: 1_000_000n,
      gasCost: 21_000_000_000_000n,
      receipt: syntheticReceipt({}),
    });
    // -(value + gasCost) + value = -gasCost. The +value credit must land on
    // the same (wallet, native) key, not be suppressed on self-transfer.
    expect(bc.size).toBe(1);
    expect(entryFor(bc, ADDR_SENDER, undefined)?.change.balanceChangeMr).toBe(
      -21_000_000_000_000n,
    );
  });

  it('ERC20 transfer log yields signed ERC20 balance changes', async () => {
    const bc = await decode({
      from: ADDR_SENDER,
      to: null,
      value: 0n,
      gasCost: 0n,
      receipt: syntheticReceipt({
        logs: [
          {
            address: ARBITRUM_USDC.identifier!,
            topics: [ERC20_TRANSFER_TOPIC, addrTopic(ADDR_SENDER), addrTopic(ADDR_RECIPIENT)],
            data: amountData(500n),
          },
        ],
      }),
    });
    expect(entryFor(bc, ADDR_SENDER, ARBITRUM_USDC.identifier)?.change.balanceChangeMr).toBe(-500n);
    expect(entryFor(bc, ADDR_RECIPIENT, ARBITRUM_USDC.identifier)?.change.balanceChangeMr).toBe(500n);
  });

  it('ERC20 self-transfer nets to zero and drops the row (upsert zero-net cleanup)', async () => {
    const bc = await decode({
      from: ADDR_SENDER,
      to: null,
      value: 0n,
      gasCost: 0n,
      receipt: syntheticReceipt({
        logs: [
          {
            address: ARBITRUM_USDC.identifier!,
            topics: [ERC20_TRANSFER_TOPIC, addrTopic(ADDR_SENDER), addrTopic(ADDR_SENDER)],
            data: amountData(500n),
          },
        ],
      }),
    });
    // With gasCost=0 there's no residual native debit either, so the map is empty.
    expect(bc.size).toBe(0);
  });

  it('mixed native + ERC20 aggregates both under the same wallet keys', async () => {
    const bc = await decode({
      from: ADDR_SENDER,
      to: ADDR_RECIPIENT,
      value: 1_000_000n,
      gasCost: 0n,
      receipt: syntheticReceipt({
        logs: [
          {
            address: ARBITRUM_USDC.identifier!,
            topics: [ERC20_TRANSFER_TOPIC, addrTopic(ADDR_SENDER), addrTopic(ADDR_RECIPIENT)],
            data: amountData(200n),
          },
        ],
      }),
    });
    expect(bc.get(ADDR_SENDER.toLowerCase())?.size).toBe(2);
    expect(bc.get(ADDR_RECIPIENT.toLowerCase())?.size).toBe(2);
  });

  it('non-canonical Transfer topic is silently ignored', async () => {
    const bc = await decode({
      from: ADDR_SENDER,
      to: null,
      value: 0n,
      gasCost: 0n,
      receipt: syntheticReceipt({
        logs: [
          {
            address: ARBITRUM_USDC.identifier!,
            topics: [
              '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
              addrTopic(ADDR_SENDER),
              addrTopic(ADDR_RECIPIENT),
            ],
            data: amountData(500n),
          },
        ],
      }),
    });
    expect(bc.size).toBe(0);
  });

  it('throws TransactionDecodeFailed when receipt has no logs array', async () => {
    const bogusReceipt = {
      hash: '0xtx',
      status: 1,
      blockNumber: 100,
      gasUsed: 21000n,
      gasPrice: 1_000_000_000n,
      from: ADDR_SENDER,
      to: ADDR_RECIPIENT,
    } as unknown as TransactionReceipt;
    try {
      await decode({ from: ADDR_SENDER, to: null, value: 0n, receipt: bogusReceipt });
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.TransactionDecodeFailed)).toBe(true);
    }
  });

  it('unknown ERC20 contract falls back to a placeholder token (no throw)', async () => {
    const unknownContract = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead';
    const bc = await decode({
      from: ADDR_SENDER,
      to: null,
      value: 0n,
      gasCost: 0n,
      receipt: syntheticReceipt({
        logs: [
          {
            address: unknownContract,
            topics: [ERC20_TRANSFER_TOPIC, addrTopic(ADDR_SENDER), addrTopic(ADDR_RECIPIENT)],
            data: amountData(7n),
          },
        ],
      }),
    });
    const senderInner = bc.get(ADDR_SENDER.toLowerCase());
    expect(senderInner?.size).toBe(1);
    const entry = [...senderInner!.values()][0];
    expect(entry.token.symbol.startsWith('UNKNOWN_')).toBe(true);
    expect(entry.token.decimals).toBe(0);
    // Assert the map key matches assetHashOf(entry.token) — invariant preservation.
    expect(senderInner!.has(assetHashOf(entry.token))).toBe(true);
  });
});
