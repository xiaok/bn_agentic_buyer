# External Sign

Use Developer Mode to preview and execute user-built contract calls and message signatures. These commands are intentionally two-step: first preview and inspect the parsed operation and security result, then execute only after explicit user confirmation.

Developer Mode can only be enabled or configured in the Binance App. Use `baw wallet settings --json` to check whether Developer Mode is active before attempting external signing. **Check it as soon as you know the request needs `contract-call` or `sign-message`** — before building calldata, quoting or previewing — so the user does not find out only at the last step. If `devMode.enabled` is false or `devMode.expiresAt` is in the past, do not run preview: tell the user Developer Mode is off and how to turn it on (below), and continue once they confirm it is on.

### Enabling Developer Mode

Tell the user to do this in the Binance App — it cannot be done through the CLI:

1. Open the **Agentic Wallet management page → Settings** (top-right icon).
2. Turn on **Developer Mode**.
3. Read and confirm the **Risk Warning**.
4. Approve the signature request the App shows.

- The wallet's total balance must be under the Developer Mode balance cap, otherwise enabling is refused (`351804`).
- Once on, Developer Mode stays active for 7 days, and each successful use extends it. After it expires (`351802`), enable it again the same way.
- After the user says it is on, re-run `baw wallet settings --json` and confirm `devMode.enabled: true` before continuing.

---

## Safety Flow

Always follow this flow:

1. Run the relevant `preview` command.
2. Show the user the parsed transaction or parsed message, `risks`, and `authorityChanges` if present.
3. Ask for explicit confirmation before executing.
4. Run `execute` only with a `requestId` returned by a successful preview.

Do not run `execute` if preview returns an error. Intercepted previews do not return a usable `requestId`.

Preview cache can expire. If execute returns an expired-preview error, run preview again.

---

## `contract-call preview`

Preview a contract call, simulate it, and get risk information.

### Syntax

```bash
baw contract-call preview --binanceChainId <binanceChainId> --from <from> --to <to> [--value <wei>] [--inputData <hex>] --json
```

For Solana:

```bash
baw contract-call preview --binanceChainId CT_501 --from <from> --unsignedTx <base64> --json
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--binanceChainId` | Yes | - | Binance chain ID, for example `56` for BSC, `1` for Ethereum, or `CT_501` for Solana. |
| `--from` | Yes | - | Agentic wallet address on the selected chain. The backend verifies ownership. |
| `--to` | EVM yes | - | Contract address to interact with. |
| `--value` | EVM no | `0` | Raw `eth_sendTransaction` value in wei, not human-readable. Must be a non-negative integer (decimal or `0x`-hex); decimals are rejected. |
| `--inputData` | EVM no | `0x` | EVM calldata. |
| `--unsignedTx` | Solana yes | - | Solana unsigned transaction, base64 encoded. |
| `--gasLimit` | EVM no | - | Custom EVM gas limit, an integer from 21000 to 15000000. Omit it and the backend estimates. See below. |

Do not pass gas price or gas option parameters — `contract-call` does not accept them. By default,
leave gas alone entirely: preview simulates the call and the backend estimates the gas limit.

#### `--gasLimit` (advanced fallback)

`--gasLimit` is the one exception, and it is a fallback rather than part of the normal flow. Do not
decide to use it yourself — pass it only when the user explicitly asks for a specific gas limit.
Otherwise omit it and let the backend estimate.

How it behaves:

- **It is a cap, not a bypass.** The transaction is still simulated, with your value as the
  ceiling. If it passes, that exact value goes on chain — no buffer is added.
- **Too low fails at preview.** If the call needs more gas than the cap, preview fails with
  `351805` instead of letting the transaction run out of gas after broadcast. `351805` is the
  generic simulation-failure code, so read the message before acting: when it points at gas ("The
  transaction ran out of gas. Please increase the gas limit and try again."), the user's value was
  too low — tell them, and let them pick a higher one.
- **Preview only.** Pass it on `preview`; `execute` takes just the `requestId` and reuses the value
  from that preview. There is nothing to pass twice.
- **EVM only.** Passing it on Solana is rejected with `351821`, as is any value outside
  21000–15000000.

### Example

```bash
baw contract-call preview --binanceChainId 56 --from 0xYourAgentWallet --to 0xTargetContract --value 0 --inputData 0x... --json
```

### Response

Successful preview:

```json
{
  "success": true,
  "data": {
    "requestId": "a1b2c3d4...",
    "parsedTx": {
      "transactionType": "Send",
      "amount": 255,
      "isMax": false,
      "recipient": "0x1234...",
      "contractAddress": "0x...",
      "memo": null
    },
    "simulationResult": {
      "simulationCode": "000000000",
      "simulationErrorDetail": null,
      "gasTokenFromData": 255,
      "balanceChanges": [],
      "allowanceChanges": [],
      "authorityChanges": [],
      "preCheckCode": ""
    },
    "risks": {
      "riskDetails": [
        {
          "code": "RISK_001",
          "title": "High Risk Address",
          "description": "The target address is flagged as high risk.",
          "riskType": "RISK",
          "order": 1
        }
      ],
      "addresses": {
        "0xabc123...": {
          "riskLevel": 5,
          "riskDetails": [
            {
              "code": "ADDR_RISK_001",
              "title": "Suspicious Address",
              "description": "This address has been associated with phishing activity.",
              "riskType": "RISK",
              "order": 1
            }
          ]
        }
      },
      "riskBehaviors": []
    },
    "tokenInfos": {
      "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee": {
        "name": "BNB Chain Native Token",
        "symbol": "BNB",
        "decimals": 18,
        "price": "..."
      }
    },
    "requireConfirmation": false,
    "expiresAt": 1784037104410
  }
}
```

Intercepted preview:

```json
{
  "success": false,
  "error": {
    "code": 351803,
    "name": "AGENT_DEV_MODE_RISK_BLOCKED",
    "message": "High risk transaction",
    "data": {
      "blockLevel": "Block",
      "blockReason": "High risk transaction",
      "risks": {}
    }
  }
}
```

### Notes

- `parsedTx.amount` is in the smallest unit (wei for native tokens), not human-readable. Divide it by the token's `decimals` from `tokenInfos` before showing it to the user.
- `requireConfirmation=false` means execute can broadcast directly.
- `requireConfirmation=true` means execute will create an order that must be approved in the Binance App.
- Intercepted previews have no `requestId`; do not attempt execute.
- `risks.riskDetails` is a list of transaction-level risk items. Each item has `code`, `title`, `description`, `riskType` (`RISK` or `CAUTION`), and `order`. When non-empty, show the risk `title` and `description` to the user before executing.
- `risks.addresses` is a map of address → `{ riskLevel, riskDetails }`. When an address has risks, mention it to the user (e.g. "The target address 0x... is flagged as risky: {title} — {description}").

---

## `contract-call execute`

Execute a contract-call preview.

### Syntax

```bash
baw contract-call execute --requestId <requestId> --json
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--requestId` | Yes | - | Request ID from a successful `contract-call preview`. |

### Example

```bash
baw contract-call execute --requestId a1b2c3d4... --json
```

### Response

Direct broadcast:

```json
{
  "success": true,
  "data": {
    "orderId": "order-xxx",
    "status": "BROADCASTED",
    "txHash": "0xabc123...",
    "message": null
  }
}
```

Pending App confirmation:

```json
{
  "success": true,
  "data": {
    "orderId": "order-xxx",
    "status": "PENDING_CONFIRMATION",
    "txHash": null,
    "message": "Please confirm in the Binance App"
  }
}
```

### Notes

- `BROADCASTED` means the transaction was signed and submitted to the chain. Use the returned `txHash` to check chain status.
- `PENDING_CONFIRMATION` means the user must approve in the Binance App before the transaction can complete.

---

## `sign-message preview`

Preview a message signature and get parsed-message and risk information.

### Syntax

```bash
baw sign-message preview --binanceChainId <binanceChainId> --message <message> --signType <signType> --json
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--binanceChainId` | Yes | - | Binance chain ID, for example `1`, `56`, or `CT_501`. |
| `--message` | Yes | - | A full `eth_signTypedData_v4` JSON-RPC request string, not a hex digest: `{"method":"eth_signTypedData_v4","params":[<signerAddress>,<typedDataJson>]}`. `params[0]` must be your own agentic wallet address; `params[1]` is the EIP-712 typed data (`domain`, `types`, `primaryType`, `message`) as a JSON string. |
| `--signType` | Yes | - | `EIP712`. |

### Example

```bash
baw sign-message preview --binanceChainId 1 --signType EIP712 --message '{"method":"eth_signTypedData_v4","params":["0xYourAgentWallet","{\"domain\":{\"name\":\"Permit2\",\"chainId\":1,\"verifyingContract\":\"0x...\"},\"primaryType\":\"Permit\",\"types\":{...},\"message\":{...}}"]}' --json
```

### Response

```json
{
  "success": true,
  "data": {
    "requestId": "e5f6g7h8...",
    "parsedMessage": {
      "messageType": "SignTypedData",
      "preCheckCode": "",
      "version": "V4",
      "message": "{...}"
    },
    "risks": {
      "riskDetails": [],
      "addresses": {},
      "riskBehaviors": []
    },
    "requireConfirmation": false,
    "expiresAt": 1784037104410
  }
}
```

### Notes

- For Permit or Permit2 messages, show the user the authority being granted before signing. It comes from `parsedMessage`: `spender`, `sigDeadline`, and `details[]` (token, amount, expiration).
- `risks` structure is the same as contract-call preview. See contract-call Notes for field details.

---

## `sign-message execute`

Execute a message-signature preview.

### Syntax

```bash
baw sign-message execute --requestId <requestId> --json
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--requestId` | Yes | - | Request ID from a successful `sign-message preview`. |

### Example

```bash
baw sign-message execute --requestId e5f6g7h8... --json
```

### Response

Direct signature:

```json
{
  "success": true,
  "data": {
    "orderId": "msg-order-xxx",
    "status": "COMPLETED",
    "signature": "363c1325...2852ae48",
    "signatureRecovery": "01",
    "message": null
  }
}
```

Pending App confirmation:

```json
{
  "success": true,
  "data": {
    "orderId": "msg-order-xxx",
    "status": "PENDING_CONFIRMATION",
    "signature": null,
    "signatureRecovery": null,
    "message": "Please confirm in the Binance App"
  }
}
```

---

## `sign-message result`

Fetch the result after `sign-message execute` returns `PENDING_CONFIRMATION` and the user confirms in the Binance App.

### Syntax

```bash
baw sign-message result --order-id <orderId> --json
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--order-id` | Yes | - | Order ID returned by `sign-message execute`. |

### Example

```bash
baw sign-message result --order-id msg-order-xxx --json
```

### Response

```json
{
  "success": true,
  "data": {
    "orderId": "msg-order-xxx",
    "status": "COMPLETED",
    "signature": "363c1325...2852ae48",
    "signatureRecovery": "01",
    "message": null
  }
}
```

`status=PENDING_CONFIRMATION` means App confirmation has not completed yet. Retry later. `REJECTED` or `EXPIRED` means no signature is available.

---

## `sign-message history`

View message signature history for the current agentic wallet.

### Syntax

```bash
baw sign-message history [--binanceChainId <binanceChainId>] [--limit <limit>] [--nextToken <token>] [--startTime <ms>] [--endTime <ms>] [--sortType <type>] --json
```

### Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--binanceChainId` | No | - | Filter by chain ID, for example `56` or `1`. If omitted, queries all chains. |
| `--limit` | No | `20` | Number of records to return. |
| `--nextToken` | No | - | Pagination cursor, taken from `nextToken` of a previous response. |
| `--startTime` | No | - | Start of the time range, Unix epoch milliseconds. |
| `--endTime` | No | - | End of the time range, Unix epoch milliseconds. |
| `--sortType` | No | - | Sort order, `DESC` or `ASC`. |

### Examples

```bash
baw sign-message history --json
baw sign-message history --binanceChainId 56 --limit 50 --json
```

### Response

```json
{
  "success": true,
  "data": {
    "nextToken": null,
    "items": [
      {
        "signatureType": "sign_message",
        "binanceChainId": "56",
        "address": "0x...",
        "signatureHash": "0x...",
        "signatureTime": 1719921600000,
        "spenderAddress": null,
        "spenderLabel": null,
        "tokenPermits": null,
        "signatureDeadline": null,
        "messageType": "SignTypedData",
        "rawData": "{\"method\":\"eth_signTypedData_v4\",\"params\":[\"0x...\",{\"domain\":{...},\"primaryType\":\"...\",\"types\":{...},\"message\":{...}}]}"
      }
    ]
  }
}
```

