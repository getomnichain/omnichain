import { Decimal } from 'decimal.js';

import { ChainError, ChainErrorKind, ChainErrorKinds, sanitizeMessage } from '../errors.ts';
import { minorUnitsToHrString } from '../transaction_status.ts';
import { toBase58CheckAddress } from './tron_keys.ts';

export const TRON_DEFAULT_FEE_LIMIT_SUN = 10_000_000;
export const TRON_DEFAULT_TIMEOUT_MS = 10_000;

export type TronJson = Record<string, unknown>;

export class TronAddressNotFoundError extends ChainError {
  constructor(message: string, meta: { address?: string } = {}) {
    super(ChainErrorKinds.InvalidAddress, message, meta);
    this.name = 'TronAddressNotFoundError';
  }
}

export class TronTransactionNotFoundError extends ChainError {
  constructor(message: string, meta: { txHash?: string } = {}) {
    super(ChainErrorKinds.RpcError, message, meta);
    this.name = 'TronTransactionNotFoundError';
  }
}

export class TronApiError extends ChainError {
  readonly code: string | null;

  constructor(kind: ChainErrorKind, message: string, code: string | null) {
    super(kind, message);
    this.name = 'TronApiError';
    this.code = code;
  }
}

export class TronTvmError extends ChainError {
  constructor(message: string) {
    super(ChainErrorKinds.SimulationFailed, message);
    this.name = 'TronTvmError';
  }
}

export interface TronClientInit {
  endpointUri: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class TronClient {
  readonly endpointUri: string;
  readonly useApiKey: boolean;
  readonly timeoutMs: number;
  readonly feeLimitSun = TRON_DEFAULT_FEE_LIMIT_SUN;
  private readonly apiKey: string | undefined;

  constructor(init: TronClientInit) {
    this.endpointUri = init.endpointUri;
    this.useApiKey = this.endpointUri.includes('trongrid') && init.apiKey !== undefined;
    this.apiKey = init.apiKey;
    this.timeoutMs = init.timeoutMs ?? TRON_DEFAULT_TIMEOUT_MS;
  }

  async makeRequest(method: string, params: TronJson = {}): Promise<TronJson> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.useApiKey && this.apiKey !== undefined) headers['Tron-Pro-Api-Key'] = this.apiKey;
    const url = new URL(method, this.endpointUri).toString();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Tron ${method} request failed: ${err instanceof Error ? err.message : String(err)}`, this.endpointUri),
      );
    }
    const text = await response.text();
    if (this.useApiKey && response.status === 403 && text.includes('Exceed the user daily usage')) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Tron ${method}: TronGrid API key exceeded its daily usage (rate limit! please add more API keys)`, this.endpointUri),
      );
    }
    if (!response.ok) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Tron ${method} HTTP ${response.status}: ${text.slice(0, 300)}`, this.endpointUri),
      );
    }
    try {
      return JSON.parse(text) as TronJson;
    } catch {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Tron ${method} returned a non-JSON body: ${text.slice(0, 300)}`, this.endpointUri),
      );
    }
  }

  handleApiError(payload: TronJson): void {
    if (payload.result === true) return;
    if ('Error' in payload) {
      throw new TronApiError(ChainErrorKinds.RpcError, String(payload.Error), null);
    }
    if ('code' in payload) {
      const code = String(payload.code);
      const message = decodeApiMessage(payload);
      if (code === 'TOO_BIG_TRANSACTION_ERROR') {
        throw new TronApiError(ChainErrorKinds.TransactionTooLarge, `${code}: ${message}`, code);
      }
      throw new TronApiError(ChainErrorKinds.BroadcastRejected, `${code}: ${message}`, code);
    }
    if ('result' in payload && payload.result !== null && typeof payload.result === 'object' && !Array.isArray(payload.result)) {
      this.handleApiError(payload.result as TronJson);
    }
  }

  async getAccount(address: string): Promise<TronJson> {
    const ret = await this.makeRequest('wallet/getaccount', { address: toBase58CheckAddress(address), visible: true });
    if (Object.keys(ret).length > 0) return ret;
    throw new TronAddressNotFoundError('account not found on-chain', { address });
  }

  async getAccountBalance(address: string): Promise<Decimal> {
    const info = await this.getAccount(address);
    return new Decimal(minorUnitsToHrString(BigInt(String(info.balance ?? 0)), 6));
  }

  async getNodeInfo(): Promise<TronJson> {
    return this.makeRequest('wallet/getnodeinfo', { visible: true });
  }

  async getLatestSolidBlock(): Promise<TronJson> {
    return this.makeRequest('walletsolidity/getnowblock');
  }

  async getLatestSolidBlockId(): Promise<string> {
    try {
      const info = await this.makeRequest('wallet/getnodeinfo');
      const solidity = String(info.solidityBlock);
      const marker = solidity.indexOf(',ID:');
      return marker === -1 ? solidity : solidity.slice(marker + ',ID:'.length);
    } catch {
      const block = await this.getLatestSolidBlock();
      return String(block.blockID);
    }
  }

  async getLatestBlockNumber(): Promise<number> {
    const info = await this.makeRequest('wallet/getnodeinfo');
    const block = String(info.block);
    return Number.parseInt(block.split(',ID:', 1)[0].replace('Num:', ''), 10);
  }

  async getTransaction(txId: string): Promise<TronJson> {
    if (txId.length !== 64) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'wrong transaction hash length', { txHash: txId });
    }
    const ret = await this.makeRequest('wallet/gettransactionbyid', { value: txId, visible: true });
    this.handleApiError(ret);
    if (Object.keys(ret).length > 0) return ret;
    throw new TronTransactionNotFoundError('transaction not found', { txHash: txId });
  }

  async getTransactionInfo(txId: string): Promise<TronJson> {
    if (txId.length !== 64) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'wrong transaction hash length', { txHash: txId });
    }
    const ret = await this.makeRequest('wallet/gettransactioninfobyid', { value: txId, visible: true });
    this.handleApiError(ret);
    if (Object.keys(ret).length > 0) return ret;
    throw new TronTransactionNotFoundError('transaction info not found', { txHash: txId });
  }

  async getChainParameters(): Promise<Array<{ key: string; value?: number }>> {
    const params = await this.makeRequest('wallet/getchainparameters', { visible: true });
    return (params.chainParameter as Array<{ key: string; value?: number }> | undefined) ?? [];
  }

  async getContract(address: string): Promise<TronJson> {
    const base58 = toBase58CheckAddress(address);
    const info = await this.makeRequest('wallet/getcontract', { value: base58, visible: true });
    try {
      this.handleApiError(info);
    } catch (err) {
      if (err instanceof TronApiError && err.code === null) {
        throw new TronAddressNotFoundError('contract address not found', { address: base58 });
      }
      throw err;
    }
    return info;
  }

  async triggerConstantContract(
    ownerAddress: string,
    contractAddress: string,
    functionSelector: string,
    parameter: string,
  ): Promise<TronJson> {
    const ret = await this.makeRequest('wallet/triggerconstantcontract', {
      owner_address: toBase58CheckAddress(ownerAddress),
      contract_address: toBase58CheckAddress(contractAddress),
      function_selector: functionSelector,
      parameter,
      visible: true,
    });
    this.handleApiError(ret);
    const result = (ret.result ?? {}) as TronJson;
    if (result !== null && typeof result === 'object' && 'message' in result) {
      let message = String(result.message);
      const constantResult = (ret.constant_result as string[] | undefined) ?? [];
      const revertString = decodeRevertString(constantResult[0]);
      if (revertString !== null) message = `${message}: ${revertString}`;
      throw new TronTvmError(message);
    }
    return ret;
  }

  async triggerConstSmartContractFunction(
    ownerAddress: string,
    contractAddress: string,
    functionSelector: string,
    parameter: string,
  ): Promise<string> {
    const ret = await this.triggerConstantContract(ownerAddress, contractAddress, functionSelector, parameter);
    return (ret.constant_result as string[])[0];
  }

  async broadcast(transactionJson: TronJson): Promise<TronJson> {
    const payload = await this.makeRequest('wallet/broadcasttransaction', transactionJson);
    this.handleApiError(payload);
    return payload;
  }

  async getSignWeight(transactionJson: TronJson): Promise<TronJson> {
    return this.makeRequest('wallet/getsignweight', transactionJson);
  }
}

function decodeApiMessage(payload: TronJson): string {
  const rawMessage = payload.message;
  if (typeof rawMessage === 'string' && /^([0-9a-fA-F]{2})*$/.test(rawMessage)) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(rawMessage, 'hex'));
    } catch {
      return rawMessage;
    }
  }
  return rawMessage === undefined ? JSON.stringify(payload) : String(rawMessage);
}

function decodeRevertString(resultHex: string | undefined): string | null {
  if (resultHex === undefined || resultHex.length <= (4 + 32) * 2) return null;
  try {
    const body = Buffer.from(resultHex, 'hex').subarray(4 + 32);
    const length = Number(BigInt(`0x${body.subarray(0, 32).toString('hex')}`));
    return body.subarray(32, 32 + length).toString('utf8');
  } catch {
    return null;
  }
}
