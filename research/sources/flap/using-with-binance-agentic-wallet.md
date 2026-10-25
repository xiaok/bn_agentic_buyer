> For the complete documentation index, see [llms.txt](https://docs.flap.sh/flap/llms.txt). Markdown versions of documentation pages are available by appending `.md` to page URLs; this page is available as [Markdown](https://docs.flap.sh/flap/skills/using-with-binance-agentic-wallet.md).

# Using Flap Skills with the Binance Agentic Wallet

This tutorial walks through launching a token on Flap **entirely from a chat with your AI agent** on BNB chAIn — no manual transaction signing, no copy-pasting calldata into a wallet UI. It combines two agent skills:

* [**binance-agentic-wallet**](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/SKILL.md) — lets your agent sign in to a Binance Agentic Wallet and sign/broadcast transactions on your behalf, with your explicit confirmation at each step.
* [**launch-bnb-token-on-flap**](https://github.com/flap-sh/flap-skills/blob/main/launch-bnb-token-on-flap/SKILL.md) — the skill described earlier in this chapter, which builds the Flap token-launch transaction.

These are not OpenClaw-exclusive skills — they follow a common skill format usable by any compatible agent, including Claude Code, Codex, OpenClaw, and Hermes. The examples below use generic instructions you can paste into any of them.

{% hint style="info" %}
The Binance Agentic Wallet's simulator has an internal gas ceiling on `contract-call preview`. As of this writing it has been raised to **5,000,000 gas**, comfortably above what a tax-token launch needs (\~2.0–2.5M gas depending on quote token and vault configuration). If a preview ever fails with a generic `"Transaction simulation failed: execution reverted"` error, independently verify the calldata against a live RPC node (e.g. with `cast call`) before assuming the transaction itself is invalid — the error message doesn't distinguish a real revert from a simulator-side limit.
{% endhint %}

***

## Step 1 — Install the Binance Agentic Wallet skill

Tell your agent:

```
Install the binance-agentic-wallet skill from https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/SKILL.md
```

Your agent will fetch and register the skill (and its CLI dependency, `baw`) so it knows how to drive wallet sign-in, balance checks, and transaction signing on your behalf.

***

## Step 2 — Sign in to your Agentic Wallet

Ask your agent to sign you in:

```
Sign me in to my Binance Agentic Wallet.
```

The agent starts the sign-in flow and gives you a **pairing code** and a **link to open** (or a QR code to scan) in the Binance App. It will look something like this — your actual code and link will differ, and both are single-use / time-limited (\~5 minutes):

```
Sign-in initiated. Please confirm in the Binance App.

Pairing code: 6█████1
Open this link on your phone (or scan the QR code shown):
https://web3.binance.com/en/agent-login?expireAt=████████████&url=████████████████████████████████

Waiting for confirmation in the Binance App...
```

1. Open the link (or scan the QR code) with the device that has your **Binance App** installed.
2. Confirm that the pairing code shown in the app matches the one your agent gave you.
3. Approve the sign-in inside the app.

Your agent's sign-in call blocks until you approve — once it returns successfully, your agent can confirm the wallet is connected and show you its address.

{% hint style="warning" %}
Never share your pairing code or sign-in link with anyone else, and don't paste them anywhere other than the official Binance App. Treat them like a login credential — anyone who completes the pairing gets agent-level control of that wallet.
{% endhint %}

***

## Step 3 — Configure your wallet's security settings (in the Binance App)

Before your agent can build and broadcast Flap launch transactions, three settings need to be adjusted **in the Binance App** — the CLI can only read these, not change them. Open the **Agentic Wallet management page → settings icon (top right)** and set:

| Setting                           | Value to set                                     | Why                                                                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Developer Mode**                | Enabled                                          | Required for any `contract-call preview`/`execute` — this is what lets your agent construct and sign arbitrary contract calls like `Portal.newTokenV6`, instead of only pre-built actions (send, swap, etc).                          |
| **Abnormal Transaction Handling** | `Need Confirmation` (instead of `Auto Reject`)   | A brand-new, unverified token contract can look "abnormal" to Binance's risk engine. `Need Confirmation` routes flagged transactions to you for a manual approve/reject in the app instead of silently blocking them.                 |
| **Tradable Tokens**               | `All tokens` (instead of the default allow-list) | The token you're launching doesn't exist yet, so it can't be on any allow-list. Widening this setting lets the wallet interact with newly created tokens (relevant for any post-launch buy/sell testing, not the launch call itself). |

Ask your agent to confirm these took effect:

```
Check my wallet settings and confirm Developer Mode is enabled.
```

***

## Step 4 — Install the Flap token-launch skill

```
Install the launch-bnb-token-on-flap skill from https://github.com/flap-sh/flap-skills/blob/main/launch-bnb-token-on-flap/SKILL.md
```

This is the skill described earlier in this chapter — see [Launch a BNB Token on Flap](/flap/skills.md) for what it covers and the four example prompts. It only launches **Flap Tax Token V3** tokens (standard/non-tax tokens are out of scope as of v1.3.0), and it supports quoting against any token in Flap's live quote-token list, not just native BNB.

***

## Step 5 — Launch a token quoted against a BStock

Besides native BNB and stablecoins, Flap lets you quote a launch against any of the **BStocks** currently supported on BNB Chain. The current list, category `rwa`, fetched live from Flap's `/api/launch/quote-tokens` endpoint (`chainId == 56`):

| Symbol | Underlying        |
| ------ | ----------------- |
| SPCXB  | SpaceX            |
| SKHYB  | SK Hynix          |
| SPYB   | SPY               |
| QQQB   | Invesco QQQ Trust |
| NVDAB  | NVIDIA            |
| AAPLB  | Apple             |
| TSLAB  | Tesla             |
| MSFTB  | Microsoft         |
| GOOGLB | Alphabet          |
| HOODB  | Robinhood         |
| BABAB  | Alibaba           |
| GMEB   | GameStop          |

{% hint style="info" %}
This list changes over time as Binance issues new BStocks — always have your agent re-fetch `/api/launch/quote-tokens` rather than relying on a hardcoded list (including the table above).
{% endhint %}

This example launches a tax token quoted against one of these BStocks instead of native BNB, using your now-connected Agentic Wallet as the signer. The specific BStock ticker and the resulting quote-token address are redacted below (shown as `████`) since the choice is arbitrary — swap in any symbol from the table above.

```
Use my agentic wallet to launch a token named "chAIn" on Flap BNB, symbol chAIn.
Quote it against ████ instead of BNB.
No vault. Set buy tax and sell tax both to 1%.
Route 100% of tax revenue to dividends.
Skip the initial buy.
```

Your agent will:

1. Resolve the chosen BStock's address and decimals from Flap's `/api/launch/quote-tokens` endpoint.
2. Upload your token's metadata (name, symbol, image, description) to Flap's IPFS gateway.
3. Mine a vanity CREATE2 salt so the token address ends in `7777`.
4. Encode the full `Portal.newTokenV6` calldata — including setting `dividendToken` to the BStock's address, since Flap requires the dividend token to match the quote token whenever quoting in a non-native ERC-20 with dividends enabled.
5. Independently sanity-check the transaction (e.g. via a `cast call` simulation against a live RPC) before ever touching your wallet.

### The two-step confirmation flow

Every contract call through the Agentic Wallet is deliberately split into a **preview** and an **execute** step, so nothing is signed without you seeing exactly what it does first.

**Request (preview):** the agent runs `contract-call preview` and shows you the parsed result (the address, IDs, and quote token below are illustrative placeholders, not a real launch):

```
Preview succeeded.

Type:              Contract Interaction
Contract:          Portal (0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0)
Quote token:        ████ (0x████████████████████████████████████████)
Meta CID:           bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku (empty)
Predicted address:  0x██████████████████████████████████7777  (vanity suffix 7777)
Tax:                1% buy / 1% sell
Dividend:           100% of tax revenue, paid in ████
Initial buy:        skipped (quoteAmt = 0)
Risks flagged:      none
requireConfirmation: false  → would broadcast directly if executed

Shall I go ahead and execute this?
```

At this point **nothing has been signed or broadcast** — this is purely a simulation, run against Binance's backend, that tells you what the transaction would do.

**Confirm (execute):** only after you explicitly say "yes" does the agent run `contract-call execute` with the `requestId` from the preview:

```
Broadcasted.

Order ID:  ████████████████████
Tx hash:   0x240b9e67ddc824588c3c4d1e1af7437bee28f812a5eafb41b64f1ce312c5b49e
Status:    BROADCASTED
```

The agent then polls the chain to confirm the transaction landed, and reports back the final token address and a link to view it:

```
Confirmed on-chain — status: success.

Token launched: chAIn (chAIn)
Address: 0x██████████████████████████████████7777
https://flap.sh/bnb/0x██████████████████████████████████7777
```

{% hint style="info" %}
If `contract-call preview` ever fails with a generic `SERVICE_ERROR` / `"execution reverted"` message and you believe the transaction should be valid, ask your agent to cross-check the same calldata against a live RPC node independently (e.g. `cast call`). This distinguishes a genuine on-chain revert (bad parameters) from a wallet-side simulation limitation — the error message alone can't tell you which one happened.
{% endhint %}
