import { ChainErrorKinds, isChainError } from '../../errors.ts';
import {
  ERC20_TRANSFER_TOPIC,
  EvmParsedTransactionLog,
} from '../evm_transaction_status.ts';

const TOPIC_FROM = '0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOPIC_TO = '0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const DATA_100 = '0x' + '0'.repeat(62) + '64'; // 100 wei

describe('EvmParsedTransactionLog.isTransferLog', () => {
  it('accepts a canonical ERC-20 Transfer (3 topics, right topic0)', () => {
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [ERC20_TRANSFER_TOPIC, TOPIC_FROM, TOPIC_TO],
      DATA_100,
    );
    expect(log.isTransferLog()).toBe(true);
  });

  it('rejects a 2-topic anonymous event', () => {
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [ERC20_TRANSFER_TOPIC, TOPIC_FROM],
      DATA_100,
    );
    expect(log.isTransferLog()).toBe(false);
  });

  it('rejects a 3-topic log with the wrong topic0', () => {
    const wrongTopic0 = '0x' + 'a'.repeat(64);
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [wrongTopic0, TOPIC_FROM, TOPIC_TO],
      DATA_100,
    );
    expect(log.isTransferLog()).toBe(false);
  });

  it('is case-insensitive on topic0 hex', () => {
    const upper = ERC20_TRANSFER_TOPIC.toUpperCase().replace(/^0X/, '0x');
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [upper, TOPIC_FROM, TOPIC_TO],
      DATA_100,
    );
    expect(log.isTransferLog()).toBe(true);
  });
});

describe('EvmParsedTransactionLog.asTransferLog — strict validation', () => {
  it('decodes a canonical log — value + lowercased addresses', () => {
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [ERC20_TRANSFER_TOPIC, TOPIC_FROM, TOPIC_TO],
      DATA_100,
    );
    const t = log.asTransferLog();
    expect(t.value).toBe(100n);
    expect(t.tokenContract).toBe('0xtoken');
    expect(t.fromAddress).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(t.toAddress).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  });

  it('throws InvalidArgument on a non-Transfer log (isTransferLog false)', () => {
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [ERC20_TRANSFER_TOPIC, TOPIC_FROM],
      DATA_100,
    );
    try {
      log.asTransferLog();
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.InvalidArgument)).toBe(true);
    }
  });

  it('throws TransactionDecodeFailed on a short topic1', () => {
    const shortTopic = '0x0000';
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [ERC20_TRANSFER_TOPIC, shortTopic, TOPIC_TO],
      DATA_100,
    );
    try {
      log.asTransferLog();
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.TransactionDecodeFailed)).toBe(true);
    }
  });

  it('throws TransactionDecodeFailed on a topic with non-hex chars', () => {
    const badTopic = '0x' + 'g'.repeat(64);
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [ERC20_TRANSFER_TOPIC, badTopic, TOPIC_TO],
      DATA_100,
    );
    try {
      log.asTransferLog();
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.TransactionDecodeFailed)).toBe(true);
    }
  });

  it('throws TransactionDecodeFailed on empty data', () => {
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [ERC20_TRANSFER_TOPIC, TOPIC_FROM, TOPIC_TO],
      '0x',
    );
    try {
      log.asTransferLog();
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.TransactionDecodeFailed)).toBe(true);
    }
  });

  it('throws TransactionDecodeFailed on data longer than 32 bytes', () => {
    const bigData = '0x' + '0'.repeat(64) + '0'.repeat(4); // 34 bytes
    const log = new EvmParsedTransactionLog(
      '0xTOKEN',
      [ERC20_TRANSFER_TOPIC, TOPIC_FROM, TOPIC_TO],
      bigData,
    );
    try {
      log.asTransferLog();
      fail('expected throw');
    } catch (err) {
      expect(isChainError(err, ChainErrorKinds.TransactionDecodeFailed)).toBe(true);
    }
  });
});
