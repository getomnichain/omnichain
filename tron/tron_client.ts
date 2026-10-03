import { Decimal } from 'decimal.js';

import { bytesFromHex } from '../bytes_from_hex.ts';
import { ChainError, ChainErrorKind, ChainErrorKinds, sanitizeMessage } from '../errors.ts';
import { pyDecodeUtf8 } from '../python_builtins.ts';
import { pyRepr, pyStr } from '../python_repr.ts';
import { minorUnitsToHrString } from '../transaction_status.ts';
import { toBase58CheckAddress } from './tron_keys.ts';

export const TRON_DEFAULT_FEE_LIMIT_SUN = 10_000_000;
export const TRON_DEFAULT_TIMEOUT_MS = 10_000;
export const TRONPY_USER_AGENT = 'Tronpy/0.6.2';
const TRONPY_SINGLE_MESSAGE_ERROR_CODES = new Set(['SIGERROR', 'TAPOS_ERROR', 'TRANSACTION_EXPIRATION_ERROR', 'CONTRACT_VALIDATE_ERROR']);

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
  readonly #apiKey: string | undefined;

  constructor(init: TronClientInit) {
    this.endpointUri = init.endpointUri;
    this.useApiKey = this.endpointUri.includes('trongrid') && init.apiKey !== undefined;
    this.#apiKey = init.apiKey;
    this.timeoutMs = init.timeoutMs ?? TRON_DEFAULT_TIMEOUT_MS;
  }

  async makeRequest(method: string, params: TronJson = {}): Promise<TronJson> {
    const headers: Record<string, string> = { 'User-Agent': TRONPY_USER_AGENT, 'Content-Type': 'application/json' };
    if (this.useApiKey && this.#apiKey !== undefined) headers['Tron-Pro-Api-Key'] = this.#apiKey;
    const url = new URL(method, this.endpointUri).toString();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const restartTimeout = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`timed out after ${this.timeoutMs} ms without a response`)), this.timeoutMs);
    };
    let response: Response;
    let body: Uint8Array;
    try {
      restartTimeout();
      response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(params), redirect: 'manual', signal: controller.signal });
      restartTimeout();
      body = await readBody(response, restartTimeout);
    } catch (err) {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Tron ${method} request failed: ${transportErrorMessage(err, controller.signal)}`, this.endpointUri),
      );
    } finally {
      clearTimeout(timer);
    }
    if (this.useApiKey && response.status === 403 && Buffer.from(body).includes('Exceed the user daily usage')) {
      throw new TronApiError(ChainErrorKinds.RpcError, 'rate limit! please add more API keys', null);
    }
    if (response.status < 200 || response.status > 299) {
      throw new ChainError(ChainErrorKinds.RpcError, sanitizeMessage(httpxStatusErrorMessage(response, url), this.endpointUri.replace(/\/+$/, '')));
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as TronJson;
    } catch {
      throw new ChainError(
        ChainErrorKinds.RpcError,
        sanitizeMessage(`Tron ${method} returned a non-JSON body: ${Buffer.from(body).toString('utf8').slice(0, 300)}`, this.endpointUri),
      );
    }
  }

  handleApiError(payload: TronJson): void {
    if (payload.result === true) return;
    if ('Error' in payload) {
      throw new TronApiError(ChainErrorKinds.RpcError, pyStr(payload.Error), null);
    }
    if ('code' in payload) {
      const code = String(payload.code);
      const message = decodeApiMessage(payload);
      if (code === 'TOO_BIG_TRANSACTION_ERROR') {
        throw new TronApiError(ChainErrorKinds.TransactionTooLarge, pyStr(message), code);
      }
      if (TRONPY_SINGLE_MESSAGE_ERROR_CODES.has(code)) {
        throw new TronApiError(ChainErrorKinds.BroadcastRejected, pyStr(message), code);
      }
      throw new TronApiError(ChainErrorKinds.BroadcastRejected, `(${pyRepr(message)}, ${pyRepr(payload.code)})`, code);
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
      const solidity = requireStringField(info, 'solidityBlock', 'wallet/getnodeinfo');
      const marker = solidity.indexOf(',ID:');
      return marker === -1 ? solidity : solidity.slice(marker + ',ID:'.length);
    } catch {
      const block = await this.getLatestSolidBlock();
      return requireStringField(block, 'blockID', 'walletsolidity/getnowblock');
    }
  }

  async getLatestBlockNumber(): Promise<number> {
    const info = await this.makeRequest('wallet/getnodeinfo');
    const block = requireStringField(info, 'block', 'wallet/getnodeinfo');
    const number = block.split(',ID:', 1)[0].replace('Num:', '');
    if (!/^\s*[+-]?\d+\s*$/.test(number)) {
      throw new ChainError(ChainErrorKinds.RpcError, `Tron wallet/getnodeinfo returned a malformed block field`);
    }
    return Number.parseInt(number, 10);
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
      let message = pyStr(result.message);
      const constantResult = (ret.constant_result as unknown[] | undefined) ?? [];
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

function decodeApiMessage(payload: TronJson): unknown {
  const rawMessage = payload.message;
  try {
    if (typeof rawMessage !== 'string') throw new TypeError('fromhex() argument must be str');
    return pyDecodeUtf8(bytesFromHex(rawMessage));
  } catch {
    return rawMessage === undefined ? pyRepr(payload) : rawMessage;
  }
}

function decodeRevertString(resultHex: unknown): string | null {
  if (typeof resultHex !== 'string' || resultHex.length <= (4 + 32) * 2) return null;
  try {
    const body = bytesFromHex(resultHex).subarray(4 + 32);
    if (body.length < 32) return null;
    const length = BigInt(`0x${Buffer.from(body.subarray(0, 32)).toString('hex')}`);
    const paddedLength = ((length + 31n) / 32n) * 32n;
    if (BigInt(body.length) < 32n + paddedLength) return null;
    const data = body.subarray(32, 32 + Number(length));
    if (body.subarray(32 + Number(length), 32 + Number(paddedLength)).some((byte) => byte !== 0)) return null;
    return pyDecodeUtf8(data);
  } catch {
    return null;
  }
}

function requireStringField(payload: TronJson, field: string, method: string): string {
  const value = payload[field];
  if (typeof value !== 'string') {
    throw new ChainError(ChainErrorKinds.RpcError, `Tron ${method} response has no ${field}`);
  }
  return value;
}

async function readBody(response: Response, onChunk: () => void): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    onChunk();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function transportErrorMessage(err: unknown, signal: AbortSignal): string {
  if (signal.aborted && signal.reason instanceof Error) return signal.reason.message;
  return err instanceof Error ? err.message : String(err);
}

const HTTPX_STATUS_ERROR_TYPES: Record<number, string> = {
  1: 'Informational response',
  3: 'Redirect response',
  4: 'Client error',
  5: 'Server error',
};

function httpxStatusErrorMessage(response: Response, url: string): string {
  const errorType = HTTPX_STATUS_ERROR_TYPES[Math.floor(response.status / 100)] ?? 'Invalid status code';
  const location = response.headers.get('location');
  const redirect = response.status >= 300 && response.status < 400 && location !== null ? `\nRedirect location: '${location}'` : '';
  return `${errorType} '${response.status} ${response.statusText}' for url '${url}'${redirect}\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/${response.status}`;
}
