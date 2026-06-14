# EVM chains

`EvmChain` covers any Ethereum-compatible chain (Mainnet, Arbitrum, Base,
BNB, Polygon, …). It wraps `ethers.js` v6 for RPC and ERC-20 transfers.

## Files

- [evm_chain.ts](../evm/evm_chain.ts) — `EvmChain extends Chain`
- [evm_address.ts](../evm/evm_address.ts) — `EvmAddress extends Address`; EIP-55 checksum-aware
- [evm_token.ts](../evm/evm_token.ts) — `EvmToken extends Token`; native + ERC-20
- [evm_chains.ts](../evm/evm_chains.ts) — per-chain factories (`arbitrumChain`, `baseChain`, `bnbChain`)
- [evm_tokens.ts](../evm/evm_tokens.ts) — predefined token instances per chain
- [unsigned_evm_transaction.ts](../evm/unsigned_evm_transaction.ts) — `UnsignedEvmTransaction` with `{ chainId, to, value, data, from? }`

## Constructing a chain

Each chain has a factory function that takes an optional `rpcUrl`. If
omitted, falls back to the `<CHAIN>_RPC_URL` env var, then to
`http://127.0.0.1:8545`.

```ts
import { arbitrumChain, baseChain, bnbChain } from 'src/modules/chain';

const arb = arbitrumChain('https://arb1.arbitrum.io/rpc');
const base = baseChain(); // reads BASE_RPC_URL
```

For chains without a pre-built factory, construct `EvmChain` directly:

```ts
import { EvmChain } from 'src/modules/chain';

const polygon = new EvmChain({
  chainId: 137n,
  name: 'Polygon',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://polygonscan.com',
  nativeSymbol: 'MATIC',
  rpcUrl: process.env.POLYGON_RPC_URL!,
});
```

Use `EvmChain.create(init)` instead of `new EvmChain(...)` to verify the
RPC actually serves the chainId you declared:

```ts
const arb = await EvmChain.create({ chainId: 42161n, /* ... */ });
// throws ChainError(RpcChainIdMismatch) if the RPC reports a different chainId
```

## Tokens

```ts
import { EvmToken } from 'src/modules/chain';

const ethArb = EvmToken.native(42161n, 'ETH');
const usdcArb = EvmToken.erc20(
  42161n,
  'USDC',
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  6
);
```

ERC-20 identifiers are normalized to EIP-55 checksum form. Constructing
with a mixed-case address that fails the checksum throws.

## Predefined tokens

[evm_tokens.ts](../evm/evm_tokens.ts) exports common stablecoins per
chain — e.g. `ARBITRUM_USDC`, `BASE_USDC`. Use these instead of typing
addresses by hand where possible.

## Addresses

```ts
import { EvmAddress } from 'src/modules/chain';

const addr = new EvmAddress('0xabc…');     // throws if not 20 bytes of hex
addr.canonical();                          // lowercase, '0x'-prefixed
addr.toChecksum();                         // EIP-55 mixed case
```

If a caller passes a mixed-case address that doesn't match the EIP-55
checksum, the constructor throws — this catches typos before they reach
the chain.

## Transfers

```ts
const unsigned = await arb.createTransferUnsignedTransaction({
  from: '0xsender…',
  to:   '0xrecipient…',
  tokenIdentifier: 'NATIVE',          // or USDC's checksum address
  amount: 1_000_000_000_000_000_000n, // 1 ETH = 1e18 wei
});
// unsigned: UnsignedEvmTransaction { chainId, to, value, data, from? }
```

For ERC-20 transfers, set `tokenIdentifier` to the token's contract
address. The chain emits the calldata for the standard `transfer(to,
value)` selector against that contract:

```ts
const unsigned = await arb.createTransferUnsignedTransaction({
  from: senderAddr,
  to: recipientAddr,
  tokenIdentifier: ARBITRUM_USDC.identifier,
  amount: 5_000_000n, // 5 USDC (6 decimals)
});
// unsigned.to === ARBITRUM_USDC.identifier
// unsigned.data === '0xa9059cbb...' (transfer(address,uint256) selector + args)
```

Sign with whatever you'd normally use for EVM (ethers wallet, hardware
wallet, MPC service). The chain module never touches keys.

## Balances

```ts
const ethBalance  = await arb.getBalance('0xabc…', 'NATIVE');
const usdcBalance = await arb.getBalance('0xabc…', ARBITRUM_USDC.identifier);
// returns bigint in wei / smallest token unit
```

For unknown ERC-20s, the chain auto-resolves `decimals()` and `symbol()`
from the contract on first balance call and caches the result.

## Transaction status

```ts
const status = await arb.getTransactionStatus(txHash);
// status.status: 'Pending' | 'Success' | 'Failed' | 'NotFound'
// status.confirmations: number
// status.gasFee: { token: nativeToken, amount: bigint } | null
// status.balanceChanges: [{ address, token, amount }] (decoded ERC-20 transfers)
```

For ERC-20 transfers, the chain decodes `Transfer(from, to, value)` logs
in the receipt and emits one `BalanceChange` entry per log.

## Registry / wiring

The `ChainRegistry` auto-loads EVM chains from `config.yaml` on module
init — see [chain.config.ts](../chain.config.ts) for the schema. Each
entry needs at least one provider:

```yaml
chains:
  "42161":
    name: Arbitrum
    blockTimeSeconds: 0.25
    explorerBaseUrl: https://arbiscan.io
    nativeSymbol: ETH
    providers:
      - name: ankr
        url: https://rpc.ankr.com/arbitrum/${ANKR_API_KEY}
```

To register at runtime instead:

```ts
@Injectable()
export class MyService {
  constructor(private readonly chains: ChainRegistry) {}
  
  init() {
    const polygon = new EvmChain({ /* … */ });
    this.chains.register(polygon);
  }
}
```

## Address validation

```ts
arb.validateWalletAddress('0xabc…');       // true / false
arb.validateTokenIdentifier('NATIVE');     // true
arb.validateTokenIdentifier('0xUSDC…');    // true if valid EVM address
arb.validateTokenIdentifier('not-hex');    // false
```

## Cross-chain address parsing

```ts
import { addressFor } from 'src/modules/chain';

const a = addressFor(42161, '0xabc…');     // EvmAddress
const b = addressFor(-1,    'bc1q…');      // BtcAddress (BTC registered → -1)
```
