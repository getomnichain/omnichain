import { jest } from '@jest/globals';
import { TransactionReceipt } from 'ethers';

import { ChainErrorKinds, isChainError } from '../../errors.ts';
import { BalanceChange } from '../../transaction_status.ts';
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
  receipt: TransactionReceipt;
}): Promise<BalanceChange[]> {
  return Arbitrum.decodeBalanceChanges(args);
}

describe('decodeBalanceChanges', () => {
  it('native-only transfer yields signed native balance changes', async () => {
    const receipt = syntheticReceipt({});
    const out = await decode({
      from: ADDR_SENDER,
      to: ADDR_RECIPIENT,
      value: 1_000_000n,
      receipt,
    });
    expect(out).toHaveLength(2);
    const sender = out.find((c) => c.address === ADDR_SENDER.toLowerCase());
    const recipient = out.find((c) => c.address === ADDR_RECIPIENT.toLowerCase());
    expect(sender?.amount).toBe(-1_000_000n);
    expect(recipient?.amount).toBe(1_000_000n);
    expect(sender?.token.isNative()).toBe(true);
  });

  it('ERC20-only transfer log yields signed ERC20 balance changes', async () => {
    const receipt = syntheticReceipt({
      logs: [
        {
          address: ARBITRUM_USDC.identifier!,
          topics: [ERC20_TRANSFER_TOPIC, addrTopic(ADDR_SENDER), addrTopic(ADDR_RECIPIENT)],
          data: amountData(500n),
        },
      ],
    });
    const out = await decode({ from: ADDR_SENDER, to: null, value: 0n, receipt });
    expect(out).toHaveLength(2);
    const sender = out.find((c) => c.address === ADDR_SENDER.toLowerCase());
    const recipient = out.find((c) => c.address === ADDR_RECIPIENT.toLowerCase());
    expect(sender?.amount).toBe(-500n);
    expect(recipient?.amount).toBe(500n);
    expect(sender?.token.identifier?.toLowerCase()).toBe(ARBITRUM_USDC.identifier!.toLowerCase());
  });

  it('mixed native + ERC20 in the same tx aggregates both', async () => {
    const receipt = syntheticReceipt({
      logs: [
        {
          address: ARBITRUM_USDC.identifier!,
          topics: [ERC20_TRANSFER_TOPIC, addrTopic(ADDR_SENDER), addrTopic(ADDR_RECIPIENT)],
          data: amountData(200n),
        },
      ],
    });
    const out = await decode({
      from: ADDR_SENDER,
      to: ADDR_RECIPIENT,
      value: 1_000_000n,
      receipt,
    });
    expect(out).toHaveLength(4);
    const native = out.filter((c) => c.token.isNative());
    const erc20 = out.filter((c) => !c.token.isNative());
    expect(native).toHaveLength(2);
    expect(erc20).toHaveLength(2);
  });

  it('self-send: native balance changes empty', async () => {
    const receipt = syntheticReceipt({});
    const out = await decode({
      from: ADDR_SENDER,
      to: ADDR_SENDER,
      value: 1_000_000n,
      receipt,
    });
    expect(out).toHaveLength(0);
  });

  it('non-canonical Transfer topic is silently ignored', async () => {
    const receipt = syntheticReceipt({
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
    });
    const out = await decode({ from: ADDR_SENDER, to: null, value: 0n, receipt });
    expect(out).toHaveLength(0);
  });

  it('throws transaction_decode_failed when receipt has no logs array', async () => {
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
    const receipt = syntheticReceipt({
      logs: [
        {
          address: unknownContract,
          topics: [ERC20_TRANSFER_TOPIC, addrTopic(ADDR_SENDER), addrTopic(ADDR_RECIPIENT)],
          data: amountData(7n),
        },
      ],
    });
    const out = await decode({ from: ADDR_SENDER, to: null, value: 0n, receipt });
    expect(out).toHaveLength(2);
    expect(out[0].token.symbol.startsWith('UNKNOWN_')).toBe(true);
    expect(out[0].token.decimals).toBe(0);
  });
});
