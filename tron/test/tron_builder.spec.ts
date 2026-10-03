import { jest } from '@jest/globals';
import { Decimal } from 'decimal.js';

import { CHAIN_ID_TRON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { FeePriority } from '../../priority.ts';
import { StellarGasPricing } from '../../stellar/stellar_gas_pricing.ts';
import { TRON_USDT } from '../tron_assets.ts';
import { TronAsset } from '../tron_asset.ts';
import { TronChain } from '../tron_chain.ts';
import { TronClient, TronJson } from '../tron_client.ts';
import { TronGasPricing } from '../tron_gas_pricing.ts';
import { TronPrivateKey, TronSignature, hexToBytes, toHexAddress } from '../tron_keys.ts';
import { TronApproveTransactionPrerequisite, TronSignedTransaction, TronUnsignedTransaction } from '../tron_transactions.ts';
import { TronWallet } from '../tron_wallet.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SENDER = TronWallet.fromMnemonic(MNEMONIC);
const RECEIVER = 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK';
const SPENDER = 'TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4';
const BLOCK_ID = '0000000004a3b2c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5';
const TXID = 'aa'.repeat(32);
const WRONG_PREFIX_T_ADDRESS = 'TmhM7heCdKGPVk6xNWkeM2SKwE7N78cAjP';

interface Call {
  method: string;
  params: TronJson;
}

function stubChain(handler: (method: string, params: TronJson) => TronJson | undefined = () => undefined): { chain: TronChain; calls: Call[] } {
  const calls: Call[] = [];
  const chain = new TronChain({
    name: 'Tron Stub',
    chainId: CHAIN_ID_TRON_MAINNET,
    defaultRpcUrl: 'https://api.trongrid.io',
    explorerUrl: 'https://tronscan.org',
  });
  const client = new TronClient({ endpointUri: 'https://api.trongrid.io' });
  client.makeRequest = async (method: string, params: TronJson = {}) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
    const custom = handler(method, params);
    if (custom !== undefined) return custom;
    if (method === 'wallet/getnodeinfo') return { solidityBlock: `Num:77775553,ID:${BLOCK_ID}`, block: `Num:77775570,ID:${BLOCK_ID}` };
    if (method === 'wallet/getsignweight') return { transaction: { transaction: { txID: TXID } } };
    if (method === 'wallet/getcontract') return { contract_address: params.value };
    throw new Error(`unexpected call ${method}`);
  };
  Object.defineProperty(chain, 'client', { get: () => client });
  return { chain, calls };
}

const pad = (hex: string) => hex.padStart(64, '0');
const tvm = (address: string) => toHexAddress(address).slice(2);

describe('TronChain.createTransferTransaction builds tronpy-identical raw_data', () => {
  it('native TRX: TransferContract, hex addresses, 60s expiration, solid-block TAPoS, txID from getsignweight', async () => {
    const { chain, calls } = stubChain();
    const bundle = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1.5'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
    });
    expect(bundle.prerequisites).toEqual([]);
    const tx = bundle.transaction;
    expect(tx).toBeInstanceOf(TronUnsignedTransaction);
    expect(tx.txId).toBe(TXID);
    const raw = tx.transaction.rawData;
    expect(raw.contract).toEqual([
      {
        parameter: {
          value: { owner_address: toHexAddress(SENDER.address), to_address: toHexAddress(RECEIVER), amount: 1_500_000 },
          type_url: 'type.googleapis.com/protocol.TransferContract',
        },
        type: 'TransferContract',
      },
    ]);
    expect(raw.ref_block_bytes).toBe(BLOCK_ID.slice(12, 16));
    expect(raw.ref_block_hash).toBe(BLOCK_ID.slice(16, 32));
    expect(Math.abs((raw.expiration as number) - (raw.timestamp as number) - 60_000)).toBeLessThanOrEqual(5);
    expect('fee_limit' in raw).toBe(false);
    expect(calls.map((c) => c.method)).toEqual(['wallet/getnodeinfo', 'wallet/getsignweight']);
    expect(calls[1].params).toEqual({ txID: '', raw_data: raw, signature: [], permission: null });
  });

  it('native TRX full balance keeps the 0.3 TRX reserve; memo becomes hex raw_data.data', async () => {
    const { chain } = stubChain();
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('10'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
      isFullBalance: true,
      memo: 'hi',
    });
    const value = ((transaction.transaction.rawData.contract as TronJson[])[0].parameter as TronJson).value as TronJson;
    expect(value.amount).toBe(9_700_000);
    expect(transaction.transaction.rawData.data).toBe('6869');
  });

  it('TRC-20: TriggerSmartContract with transfer(address,uint256) calldata and the 15 TRX default fee_limit', async () => {
    const { chain, calls } = stubChain();
    const usdt = chain.getTrc20Asset('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);
    const { transaction } = await chain.createTransferTransaction({
      asset: usdt,
      amountHr: new Decimal('748'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
      gasPricing: FeePriority.FAST,
    });
    const raw = transaction.transaction.rawData;
    expect(raw.fee_limit).toBe(15_000_000);
    expect(raw.contract).toEqual([
      {
        parameter: {
          value: {
            owner_address: toHexAddress(SENDER.address),
            contract_address: toHexAddress(usdt.contractAddress as string),
            data: `a9059cbb${pad(tvm(RECEIVER))}${pad((748_000_000).toString(16))}`,
            call_token_value: 0,
            call_value: 0,
            token_id: 0,
          },
          type_url: 'type.googleapis.com/protocol.TriggerSmartContract',
        },
        type: 'TriggerSmartContract',
      },
    ]);
    expect(calls[0]).toEqual({ method: 'wallet/getcontract', params: { value: usdt.contractAddress, visible: true } });
    expect(transaction.canonicalTransaction.raw_data.contract[0].type).toBe('TriggerSmartContract');
  });

  it('explicit TronGasPricing sets fee_limit; a foreign gas pricing type is rejected', async () => {
    const { chain } = stubChain();
    const usdt = chain.getTrc20Asset('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);
    const { transaction } = await chain.createTransferTransaction({
      asset: usdt,
      amountHr: new Decimal('1'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
      gasPricing: new TronGasPricing({ feeLimitSun: 30_000_000 }),
    });
    expect(transaction.transaction.rawData.fee_limit).toBe(30_000_000);
    await expect(
      chain.createTransferTransaction({
        asset: usdt,
        amountHr: new Decimal('1'),
        senderAddress: SENDER.address,
        receiverAddress: RECEIVER,
        gasPricing: new StellarGasPricing({ baseFeeStroops: 100 }),
      }),
    ).rejects.toThrow(/Expected TronGasPricing/);
  });

  it('rejects an asset from another chain and non-Tron assets', async () => {
    const { chain } = stubChain();
    const foreign = new TronAsset(2494104990, 'TRX', null, 6);
    await expect(
      chain.createTransferTransaction({ asset: foreign, amountHr: new Decimal(1), senderAddress: SENDER.address, receiverAddress: RECEIVER }),
    ).rejects.toThrow(/Invalid chain id/);
  });
});

describe('TronChain.simulateTransaction', () => {
  it('dry-runs TriggerSmartContract via wallet/triggerconstantcontract and reports energy', async () => {
    const { chain, calls } = stubChain((method) =>
      method === 'wallet/triggerconstantcontract' ? { result: { result: true }, energy_used: 13045 } : undefined,
    );
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.getTrc20Asset('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6),
      amountHr: new Decimal('0.001'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
    });
    const sim = await chain.simulateTransaction({ transaction, senderWalletAddress: SENDER.address });
    expect(sim.statusType).toBe('Success');
    expect(sim.energyUsed).toBe(13045);
    expect(sim.balanceChanges.size).toBe(0);
    const trigger = calls.find((c) => c.method === 'wallet/triggerconstantcontract');
    expect(trigger?.params).toEqual({
      owner_address: SENDER.address,
      contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      data: `a9059cbb${pad(tvm(RECEIVER))}${pad((1000).toString(16))}`,
      visible: true,
    });
    expect(await chain.supportsFullTransactionSimulation(transaction)).toBe(false);
  });

  it('turns an RPC failure into a Failed result and refuses non-VM contract types', async () => {
    const { chain } = stubChain((method) => {
      if (method === 'wallet/triggerconstantcontract') throw new Error('boom');
      return undefined;
    });
    const usdtTx = await chain.createTransferTransaction({
      asset: chain.getTrc20Asset('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6),
      amountHr: new Decimal('1'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
    });
    const failed = await chain.simulateTransaction({ transaction: usdtTx.transaction, senderWalletAddress: SENDER.address });
    expect(failed.statusType).toBe('Failed');
    expect(failed.error?.message).toBe('boom');
    expect(failed.energyUsed).toBeNull();

    const nativeTx = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('0.1'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
    });
    await expect(chain.simulateTransaction({ transaction: nativeTx.transaction, senderWalletAddress: SENDER.address })).rejects.toMatchObject({
      kind: ChainErrorKinds.FeatureNotSupported,
    });
  });
});

describe('TronWallet signing and TronChain broadcast', () => {
  it('signs the txID with the tronpy recoverable signature format and mutates the transaction like tronpy', async () => {
    const { chain } = stubChain();
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
    });
    const signed = await SENDER.signTransaction(transaction, chain);
    expect(signed).toBeInstanceOf(TronSignedTransaction);
    expect(signed.txHash).toBe(TXID);
    expect(transaction.transaction.signature).toHaveLength(1);
    const expected = TronPrivateKey.fromHex(SENDER.privateKeyHex).signMsgHash(hexToBytes(TXID)).hex();
    expect(signed.signedTransaction.signature).toEqual([expected]);
    const recovered = TronSignature.fromHex(expected).recoverPublicKeyFromMsgHash(hexToBytes(TXID));
    expect(recovered.toBase58CheckAddress()).toBe(SENDER.address);
  });

  it('refuses to sign an expired transaction or one whose permission excludes the key', async () => {
    const { chain } = stubChain((method) =>
      method === 'wallet/getsignweight'
        ? { transaction: { transaction: { txID: TXID } }, permission: { keys: [{ address: toHexAddress(RECEIVER), weight: 1 }] } }
        : undefined,
    );
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
    });
    await expect(SENDER.signTransaction(transaction, chain)).rejects.toThrow(/not in the permission list/);
    transaction.transaction.permission = null;
    transaction.transaction.rawData.expiration = Date.now() - 1;
    await expect(SENDER.signTransaction(transaction, chain)).rejects.toThrow('expired');
  });

  it('broadcastSignedTransaction keeps the tx hash and surfaces node rejections as broadcastError', async () => {
    let reply: TronJson = { result: true, txid: TXID };
    const { chain } = stubChain((method) => (method === 'wallet/broadcasttransaction' ? reply : undefined));
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
    });
    const signed = await SENDER.signTransaction(transaction, chain);
    const ok = await chain.broadcastSignedTransaction(signed);
    expect(ok.txHash).toBe(TXID);
    expect(ok.isBroadcastConfirmed).toBe(true);

    reply = { code: 'DUP_TRANSACTION_ERROR', message: Buffer.from('dup transaction').toString('hex') };
    const dup = await chain.broadcastSignedTransaction(signed);
    expect(dup.txHash).toBe(TXID);
    expect(dup.broadcastError?.message).toBe("('dup transaction', 'DUP_TRANSACTION_ERROR')");
    await expect(chain.broadcast(signed.toJsonStr())).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError, meta: { txHash: TXID } });
    reply = { result: true, txid: TXID };
    expect(await chain.broadcast(JSON.stringify(signed.signedTransaction.toJson()))).toBe(TXID);

    reply = { code: 'SIGERROR', message: Buffer.from('bad sig').toString('hex') };
    await expect(chain.broadcast(signed.toJsonStr())).rejects.toMatchObject({ kind: ChainErrorKinds.BroadcastRejected });
    await expect(chain.broadcast('not json')).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
  });

  it('the broadcast adapter calls a reply "rejected" only when the node did not accept the transaction; everything else may have landed', async () => {
    let reply: TronJson = { result: true, txid: TXID };
    const { chain } = stubChain((method) => (method === 'wallet/broadcasttransaction' ? reply : undefined));
    const { transaction } = await chain.createTransferTransaction({
      asset: chain.nativeAsset,
      amountHr: new Decimal('1'),
      senderAddress: SENDER.address,
      receiverAddress: RECEIVER,
    });
    const signed = await SENDER.signTransaction(transaction, chain);
    const expectKind = async (next: TronJson, kind: string) => {
      reply = next;
      await expect(chain.broadcast(signed.toJsonStr())).rejects.toMatchObject({ kind, meta: { txHash: TXID } });
    };

    for (const code of ['SIGERROR', 'CONTRACT_VALIDATE_ERROR', 'CONTRACT_EXE_ERROR', 'BANDWITH_ERROR']) {
      await expectKind({ code, message: '' }, ChainErrorKinds.BroadcastRejected);
    }
    await expectKind({ code: 'TOO_BIG_TRANSACTION_ERROR', message: '' }, ChainErrorKinds.TransactionTooLarge);
    for (const code of [
      'TRANSACTION_EXPIRATION_ERROR',
      'TAPOS_ERROR',
      'DUP_TRANSACTION_ERROR',
      'SERVER_BUSY',
      'NO_CONNECTION',
      'NOT_ENOUGH_EFFECTIVE_CONNECTION',
      'BLOCK_UNSOLIDIFIED',
      'OTHER_ERROR',
      'SOME_NEW_CODE',
    ]) {
      await expectKind({ code, message: '' }, ChainErrorKinds.RpcError);
    }
    await expectKind({ Error: 'class java.lang.NullPointerException : null' }, ChainErrorKinds.RpcError);
    await expectKind({}, ChainErrorKinds.RpcError);

    reply = { result: true };
    const noTxid = await chain.broadcastSignedTransaction(signed);
    expect(noTxid.txHash).toBe(TXID);
    expect(noTxid.broadcastError?.message).toBe("'txid'");
    expect(noTxid.broadcastError).toMatchObject({ kind: ChainErrorKinds.RpcError });
    await expect(chain.broadcast(signed.toJsonStr())).rejects.toMatchObject({
      kind: ChainErrorKinds.RpcError,
      message: "Tron broadcast failed: 'txid'",
      meta: { txHash: TXID },
    });
  });
});

describe('TronWallet.handleTransactionPrerequisite (TRC-20 approve)', () => {
  const allowanceReply = (value: bigint) => ({ result: { result: true }, constant_result: [pad(value.toString(16))] });

  function approveChain(allowance: bigint) {
    const broadcasts: TronJson[] = [];
    const stub = stubChain((method, params) => {
      if (method === 'wallet/triggerconstantcontract') return allowanceReply(allowance);
      if (method === 'wallet/broadcasttransaction') {
        broadcasts.push(params);
        return { result: true, txid: `${broadcasts.length}`.repeat(64) };
      }
      return undefined;
    });
    return { ...stub, broadcasts };
  }

  function approveData(tx: TronJson): string {
    return (((((tx.raw_data as TronJson).contract as TronJson[])[0].parameter as TronJson).value as TronJson).data as string);
  }

  it('approve broadcast failures use the broadcast classification and carry the txHash', async () => {
    let reply: TronJson = { result: true };
    const { chain } = stubChain((method) => {
      if (method === 'wallet/triggerconstantcontract') return allowanceReply(0n);
      if (method === 'wallet/broadcasttransaction') return reply;
      return undefined;
    });
    const prerequisite = new TronApproveTransactionPrerequisite({
      chainId: chain.chainId,
      asset: chain.getTrc20Asset('USDC', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 6),
      walletAddress: SENDER.address,
      spenderContractAddress: SPENDER,
      amount: 1_000n,
    });
    const cases: [TronJson, string][] = [
      [{ code: 'SIGERROR', message: '' }, ChainErrorKinds.BroadcastRejected],
      [{ code: 'CONTRACT_VALIDATE_ERROR', message: '' }, ChainErrorKinds.BroadcastRejected],
      [{ code: 'TRANSACTION_EXPIRATION_ERROR', message: '' }, ChainErrorKinds.RpcError],
      [{ result: true }, ChainErrorKinds.RpcError],
    ];
    for (const [next, kind] of cases) {
      reply = next;
      await expect(SENDER.handleTransactionPrerequisite(prerequisite, chain)).rejects.toMatchObject({
        kind,
        meta: { txHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
      });
    }
  });

  it('skips when the current allowance already covers the amount', async () => {
    const { chain, broadcasts } = approveChain(1_000n);
    const prerequisite = new TronApproveTransactionPrerequisite({
      chainId: chain.chainId,
      asset: chain.getTrc20Asset('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6),
      walletAddress: SENDER.address,
      spenderContractAddress: SPENDER,
      amount: 1_000n,
    });
    const response = await SENDER.handleTransactionPrerequisite(prerequisite, chain);
    expect(response.skipped).toBe(true);
    expect(broadcasts).toHaveLength(0);
  });

  it('USDT-style zero reset: approve(0), wait 3 blocks, approve(amount)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const { chain, broadcasts } = approveChain(5n);
      const prerequisite = new TronApproveTransactionPrerequisite({
        chainId: chain.chainId,
        asset: chain.getTrc20Asset('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6),
        walletAddress: SENDER.address,
        spenderContractAddress: SPENDER,
        amount: 1_000n,
      });
      const pending = SENDER.handleTransactionPrerequisite(prerequisite, chain);
      await jest.advanceTimersByTimeAsync(9_000);
      const response = await pending;
      expect(response.skipped).toBe(false);
      expect(broadcasts).toHaveLength(2);
      expect(approveData(broadcasts[0])).toBe(`095ea7b3${pad(tvm(SPENDER))}${pad('0')}`);
      expect(approveData(broadcasts[1])).toBe(`095ea7b3${pad(tvm(SPENDER))}${pad((1000).toString(16))}`);
      expect(((broadcasts[1].raw_data as TronJson).fee_limit)).toBe(25_000_000);
      expect(response.zeroResetTxHash).toBe('1'.repeat(64));
      expect(response.txHash).toBe('2'.repeat(64));
    } finally {
      jest.useRealTimers();
    }
  });

  it('non-USDT token without requiresZeroResetFirst approves directly; another wallet cannot handle it', async () => {
    const { chain, broadcasts } = approveChain(5n);
    const usdc = chain.getTrc20Asset('USDC', 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8', 6);
    const response = await SENDER.handleTransactionPrerequisite(
      new TronApproveTransactionPrerequisite({ chainId: chain.chainId, asset: usdc, walletAddress: SENDER.address, spenderContractAddress: SPENDER, amount: 9n }),
      chain,
    );
    expect(response.zeroResetTxHash).toBeNull();
    expect(broadcasts).toHaveLength(1);
    await expect(
      SENDER.handleTransactionPrerequisite(
        new TronApproveTransactionPrerequisite({ chainId: chain.chainId, asset: usdc, walletAddress: RECEIVER, spenderContractAddress: SPENDER, amount: 9n }),
        chain,
      ),
    ).rejects.toThrow(/cannot handle approve prerequisite/);
  });

  it('approve prerequisites reject native TRX', () => {
    expect(
      () =>
        new TronApproveTransactionPrerequisite({
          chainId: CHAIN_ID_TRON_MAINNET,
          asset: new TronAsset(CHAIN_ID_TRON_MAINNET, 'TRX', null, 6),
          walletAddress: SENDER.address,
          spenderContractAddress: SPENDER,
          amount: 1n,
        }),
    ).toThrow(/native TRX/);
  });
});

describe('TronChain reads and TS Chain adapters', () => {
  it('getAssetBalance: unknown account is 0 TRX, TRC-20 balanceOf is decoded exactly', async () => {
    const { chain, calls } = stubChain((method) => {
      if (method === 'wallet/getaccount') return {};
      if (method === 'wallet/triggerconstantcontract') return { result: { result: true }, constant_result: [pad((123_456_789n).toString(16))] };
      return undefined;
    });
    expect((await chain.getAssetBalance(chain.nativeAsset, SENDER.address)).toString()).toBe('0');
    const usdt = chain.getTrc20Asset('USDT', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 6);
    expect((await chain.getAssetBalance(usdt, SENDER.address)).toString()).toBe('123.456789');
    const balanceCall = calls.find((c) => c.method === 'wallet/triggerconstantcontract');
    expect(balanceCall?.params).toEqual({
      owner_address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
      contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      function_selector: 'balanceOf(address)',
      parameter: pad(tvm(SENDER.address)),
      visible: true,
    });
    expect(await chain.getBalance(SENDER.address, usdt.contractAddress as string)).toBe(123_456_789n);
  });

  it('resolveAsset reads decimals() and symbol() from the contract', async () => {
    const { chain } = stubChain((method, params) => {
      if (method !== 'wallet/triggerconstantcontract') return undefined;
      if (params.function_selector === 'decimals()') return { result: { result: true }, constant_result: [pad('12')] };
      const symbol = Buffer.from('PePe').toString('hex').padEnd(64, '0');
      return { result: { result: true }, constant_result: [`${pad('20')}${pad('4')}${symbol}`] };
    });
    const asset = await chain.resolveAsset('TMacq4TDUw5q8NFBwmbY4RLXvzvG5JTkvi');
    expect(asset).toMatchObject({ symbol: 'PePe', decimals: 18, contractAddress: 'TMacq4TDUw5q8NFBwmbY4RLXvzvG5JTkvi' });
    expect(await chain.resolveAsset(null)).toBe(chain.nativeAsset);
  });

  it('getChainTipHeight parses the latest block number from wallet/getnodeinfo', async () => {
    const { chain } = stubChain();
    expect(await chain.getChainTipHeight()).toBe(77775570);
  });

  it('verifyMessageSignature recovers the signer address', async () => {
    const { chain } = stubChain();
    const signed = SENDER.signMessage('Hello World!');
    expect(await chain.verifyMessageSignature({ message: 'Hello World!', signer: SENDER.address, signature: signed.signature })).toBe(true);
    expect(await chain.verifyMessageSignature({ message: 'Hello World!', signer: RECEIVER, signature: signed.signature })).toBe(false);
    expect(await chain.verifyMessageSignature({ message: 'Hello World!', signer: SENDER.address, signature: 'zz' })).toBe(false);
  });

  it('address validation: base58 only for validate*, all tronpy forms for format*', () => {
    const hex = toHexAddress(RECEIVER);
    expect(TronChain.formatWalletAddress(hex)).toBe(RECEIVER);
    expect(TronChain.formatWalletAddress(`0x${hex.slice(2)}`)).toBe(RECEIVER);
    expect(() => TronChain.validateWalletAddress(hex)).toThrow(/Invalid Tron wallet address/);
    expect(() => TronChain.validateWalletAddress('0x1234567890abcdef1234567890abcdef12345678')).toThrow();
    expect(() => TronChain.validateWalletAddress('not-a-real-tron-address')).toThrow();
    TronChain.validateWalletAddress('TNMk8bLuv8oWgJxsM6RKruAYJirRLRMoBh');
    TronChain.validateWalletAddress('TNMk8bLuv8oWgJxsM6RKruAYJirRLRMoBh \n');
    TronChain.validateWalletAddress(WRONG_PREFIX_T_ADDRESS);
    expect(() => new TronAsset(CHAIN_ID_TRON_MAINNET, 'USDT', '0x1234567890abcdef1234567890abcdef12345678', 6)).toThrow();
    expect(() => new TronAsset(CHAIN_ID_TRON_MAINNET, 'TRRX', null, 6)).toThrow(/expected "TRX"/);
    expect(() => new TronAsset(CHAIN_ID_TRON_MAINNET, 'TRX', null, 18)).toThrow(/decimals/);
  });

  it('explorer URLs follow tronscan conventions', () => {
    const { chain } = stubChain();
    expect(chain.getAssetExplorerUrl(TRON_USDT)).toBe('https://tronscan.org/#/token20/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(chain.getAssetExplorerUrl(chain.nativeAsset)).toBeNull();
    expect(chain.getWalletAddressExplorerUrl(RECEIVER)).toBe(`https://tronscan.org/#/address/${RECEIVER}`);
    expect(chain.getTransactionExplorerUrl(TXID)).toBe(`https://tronscan.org/#/transaction/${TXID}`);
    expect(String(chain)).toBe(`TronChain[chain_id:${CHAIN_ID_TRON_MAINNET}]`);
  });

  it('RPC URL resolution: constructor, then <NAME>_RPC_URL, then TRON_<id>_RPC_URL, then default', () => {
    const make = () =>
      new TronChain({ name: 'Tron Env Probe', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'https://default.invalid', explorerUrl: 'https://x' });
    const saved = { ...process.env };
    try {
      delete process.env.TRON_ENV_PROBE_RPC_URL;
      delete process.env[`TRON_${CHAIN_ID_TRON_MAINNET}_RPC_URL`];
      expect(make()._loadRpcUrl()).toBe('https://default.invalid');
      process.env[`TRON_${CHAIN_ID_TRON_MAINNET}_RPC_URL`] = 'https://by-id.invalid';
      expect(make()._loadRpcUrl()).toBe('https://by-id.invalid');
      process.env.TRON_ENV_PROBE_RPC_URL = 'https://by-name.invalid';
      expect(make()._loadRpcUrl()).toBe('https://by-name.invalid');
      delete process.env.TRON_ENV_PROBE_RPC_URL;
      delete process.env[`TRON_${CHAIN_ID_TRON_MAINNET}_RPC_URL`];
      const trongrid = () =>
        new TronChain({ name: 'Tron Env Probe', chainId: CHAIN_ID_TRON_MAINNET, defaultRpcUrl: 'https://api.trongrid.io', explorerUrl: 'https://x' });
      delete process.env.TRONGRID_API_KEY;
      expect(trongrid().client.useApiKey).toBe(false);
      process.env.TRONGRID_API_KEY = 'k';
      expect(trongrid().client.useApiKey).toBe(true);
      expect(make().client.useApiKey).toBe(false);
    } finally {
      process.env = saved;
    }
  });
});
