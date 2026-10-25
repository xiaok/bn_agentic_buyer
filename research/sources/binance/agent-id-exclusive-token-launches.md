# Agent ID Exclusive Token Launches → On-Chain Trade

> **This file covers one thing: taking an Agent ID exclusive token (Open Four `AgentIdExclusive`) from discovery to purchase or sale.**
> Read it when the user mentions **Agent ID 专属内盘 / Agent ID exclusive** and wants to view, buy or sell such a token.
> Two skills are involved: `meme-rush` (discovery) and `binance-agentic-wallet` (execution), plus this skill's
> `scripts/agent-id-exclusive-token-launches.mjs` (on-chain checks, quote and calldata before migration).
>
> **Scope is this sub-type only.** For any other launchpad, other ranking use cases, the full filter list or the
> complete field reference, see the `meme-rush` skill's own `SKILL.md` and `references/cli.md` — none of that is
> repeated here.

---

## 1. In one sentence

Agent ID exclusive launches are a sub-type under Open Four (`protocol=2004`). **Anyone can launch one, but during the
bonding-curve stage only addresses holding an Agent ID can buy it.**

Find the token with the `meme-rush` skill and take its `contractAddress`. **How it is traded depends on its stage:**

| Stage | Route |
|---|---|
| Not migrated (inner market / bonding curve, including the Finalizing list `rankType:20`) | Quote and build the transaction with `scripts/agent-id-exclusive-token-launches.mjs`, then send it through Developer Mode (`baw contract-call preview` → `execute`) — section 5 |
| Migrated to a DEX (outer market, `rankType:30`) | `baw market-order`, as for any DEX token — section 5 |
| Migrating | Neither route works; tell the user to wait |

Check the stage on-chain right before every trade (section 5, "Check the stage on-chain").

**If the token has not migrated yet (`migrateStatus: 0` — still on the bonding curve, including the Finalizing list
`rankType:20`), the user must hold an Agent ID before buying.** Once it migrates to a DEX (`migrateStatus: 1`,
`rankType:30`), any address can buy and sell it.

> **On what counts as an Agent ID exclusive launch.** Four.meme's Open Four `openfour.meme.AgentIdExclusive` is at
> present the only officially verified implementation of this model, and it is the one this file describes. Other
> venues may describe something similar, but their mechanics have not been verified here — do not assume the buy/sell
> rules below carry over, and do not present such a token as an Agent ID exclusive launch on the strength of its
> marketing alone. If the user asks about one, say what has and has not been verified rather than ruling it out.

**Trading rules by stage:**

| Who | Launch | Buy before migration | Sell before migration | After migration |
|---|---|---|---|---|
| Address holding an Agent ID | ✅ | ✅ | ✅ | ✅ buy and sell |
| Issuer without an Agent ID | ✅ | ❌ | ✅ (its own token) | ✅ buy and sell |
| Any other address without an Agent ID | ✅ | ❌ | ❌ | ✅ buy and sell |

In short: **any address can launch** such a token on Four.meme; until the token migrates **only Agent ID holders can
buy**, and **only Agent ID holders and the token's issuer can sell**. After it migrates to a DEX (`rankType:30`)
**every address can buy and sell** — it is an ordinary token.

These rules come from the product team. No live `AgentIdExclusive` token exists yet to verify them on-chain — if an
order is rejected, the actual error is the source of truth.

**Per-address buy cap (before migration).** Each address may hold at most **1% of the max supply**. The max supply of
these tokens is fixed at **1,000,000,000 (1B)**, so the cap is **10,000,000 tokens per address**. The cap is measured on
the address's **current holding** of this token. After migration there is no cap.

- **Remaining allowance = 10,000,000 − current holding.** Get the current holding with
  `baw wallet balance --tokenAddress <contractAddress> --binanceChainId 56 --json` (`balance`). With `--tokenAddress`
  the CLI does not hide low-value or unpriced tokens (CLI ≥ 1.12.0), so a bonding-curve token with no price yet is still
  returned. **If the token is not in the result, the holding is `0`** — only zero balances are omitted.
- **Holding unknown** only when the balance query itself fails (error, not signed in), or on a CLI older than 1.12.0,
  where `--tokenAddress` still hides tokens worth under $0.01 — there, a missing token is unknown, not `0`.
- **Excess is not charged.** The script's quote already stops at the cap: a buy by budget spends only what the allowed
  amount costs, and Core refunds the unspent BNB **in BNB, in the same transaction**; a buy by token amount is clipped
  to the remaining allowance. The quote reports this (`estimate.budgetNotFullyUsed` / `estimate.tokenAmountClipped`) —
  tell the user before confirming. At the cap, `quote-buy` returns `NOT_EXECUTABLE` with diagnosis
  `HOLDING_CAP_REACHED`.

## 2. Prerequisites

| Need | How to check | If missing |
|---|---|---|
| `meme-rush` skill | `node <meme-rush-dir>/scripts/cli.mjs --help` | Install from https://github.com/binance/binance-skills-hub |
| Wallet signed in | `baw wallet status --json` | See [authentication.md](authentication.md) |
| **Wallet holds an Agent ID** | `baw wallet agent-id --json` — see below | Without one, no buying before the token migrates; the user must claim one first ([how to claim](https://web3.binance.com/en/dev-docs/products/agentic-wallet/ai-pro#came-from-the-agent-id-campaign)) |
| Payment-token balance on BSC | `baw wallet balance --binanceChainId 56 --json` | Tell the user to top up or swap first |
| Node.js ≥ 22 (for the script) | `node --version` | Install Node.js 22+; the script has no other dependencies |
| Wallet's BSC address | `baw wallet address --json` → the entry with `binanceChainId` `"56"` | — |
| **Developer Mode on** (before migration only) | `baw wallet settings --json` → `devMode.enabled: true` and `devMode.expiresAt` in the future. Check it up front, together with the sign-in check | Tell the user how to turn it on: Binance App → Agentic Wallet management page → Settings → Developer Mode → confirm the Risk Warning → approve the signature ([external-sign.md](external-sign.md#enabling-developer-mode)). Do not run `contract-call preview` while it is off |

Developer Mode has its own trade limit (`devMode.dailyLimit`, in USDT, used: `developerModeQuotaUsed`), separate from
the swap `dailyLimit`. A trade that would exceed it is rejected with `351807` ("This transaction exceeds the developer
mode daily limit (… USDT)"). The limit can only be changed by the user, manually, in the
Binance App on their phone (Agentic Wallet management page → Settings; see [wallet-setting.md](wallet-setting.md#changing-settings)) — not through the CLI. When this happens, show
the raw error and the current `developerModeQuotaUsed` / `devMode.dailyLimit`, ask the user to raise the limit in the
App, and preview again once they have.

> **The Agent ID gate is on trading, not launching.** Any address can launch such a token; what is restricted is **who
> may buy it and who may sell it until the token migrates** (see the table in section 1). Once it migrates to a DEX
> (`rankType:30`) every address can buy and sell, and the restrictions no longer apply.
>
> The gate can be pre-checked with `baw wallet agent-id --json` (see [agent-id-claim-status.md](agent-id-claim-status.md)):
> `claimed: true` means this wallet holds an Agent ID. If `claimed: false`, tell the user they need an Agent ID to buy
> during the bonding-curve stage — the script's quote remains the source of truth, so you may still try: **if the quote
> is rejected for a missing Agent ID (diagnosis `NO_AGENT_ID`), show the user the raw error and explain that this is the
> bonding-curve entitlement gate, not a balance or network problem**, then mention they can buy after the token migrates.
>
> **Selling before the token migrates:** only Agent ID holders and the token's issuer can sell. If a user who is
> neither asks to sell before then, tell them it cannot be sold until the token migrates, or until they hold an
> Agent ID — do not attempt the sell and report it as a generic failure.
> Check with `baw wallet agent-id --json` first; if the sell is rejected anyway, show the raw error.

## 3. Step 1 · Query Agent ID exclusive tokens

Open Four is a BSC launchpad, so **`chainId` is always `"56"`**.

These launches are not a separate protocol code — they are a `tokenVersion` sub-type under `2004`. Select them with
`tokenVersionFilter`, and **always pass `protocol:[2004]` alongside it**, or tokens from other protocols come back too.
Ready-to-run queries for each stage are in the `meme-rush` skill's `SKILL.md` ("Preset: Agent ID exclusive launches"):

```bash
node <meme-rush-dir>/scripts/cli.mjs meme-rush '{"chainId":"56","rankType":<10|20|30>,"protocol":[2004],"tokenVersionFilter":{"2004":["openfour.meme.AgentIdExclusive"]},"limit":50}'
```

`rankType` picks the stage — there is no default; choose it from how the user phrased the request:

| `rankType` | Stage | The user says |
|---|---|---|
| `10` | New | "just launched", "newest" |
| `20` | Finalizing | "bonding curve", "about to migrate" |
| `30` | Migrated | "already on a DEX" |

Four things that commonly go wrong:

- **This is not `exclusive: 1`.** That is the unrelated "Binance exclusive" flag; using it returns entirely different tokens.
- **`openfour.meme.AgentIdExclusive` must match exactly.** A misspelling is not an error — it just returns an empty list.
- **An empty list is not a failure**, it may simply mean no such token exists right now. Say so plainly, and
  **do not quietly substitute another sub-type**. If the user wants to see what else Open Four has, drop
  `tokenVersionFilter` and query `protocol:[2004]` alone — but state that those are no longer Agent ID exclusive.
- **`limit` is capped at 100**; larger values still return 100 rows.

> Until the feature goes live this query returns an empty list. That is the **correct, expected result**, not a fault.

## 4. Step 2 · Read the returned row

Only two fields are needed to trade: `chainId` (always `"56"`) and `contractAddress`.

When reporting the row to the user:

| Field | How to read it |
|---|---|
| `contractAddress` | This flow is BSC-only, so `contractAddress` alone identifies the token. **`symbol` is not unique** — batch launches reuse names, never match by name |
| `progress` | Bonding-curve progress, pre-formatted — append `%`, do not multiply by 100 |
| `price` / `marketCap` / `liquidity` / `holders` | `null` within ~30 s of creation: absent, not zero |
| `taxRateBuy` / `taxRateSell` | `null` = **unknown**. Never display as `0%` or call it "low tax" |
| `devPosition` | `2` = dev sold everything; `null` = **unknown** |
| `netBuy` | Net buy amount in **USD** — show as a dollar amount, never append `%` |
| `holders*Percent` / `devSellPercent` | Percentages, pre-formatted — append `%` directly, do not multiply by 100 |
| `icon` | Relative path — prefix `https://bin.bnbstatic.com` |

**Never present a `null` as a reassuring value.** Say "unknown" or "not evaluated".

The complete field list is in the `meme-rush` skill's `references/cli.md`.

## 5. Step 3 · Quote, confirm, trade

### Check the stage on-chain

Run `info` right before trading — the token may have migrated since the `meme-rush` listing. Use it on its own too
when the user asks whether a token is an Agent ID exclusive token, or whether it is on the inner (内盘) or outer
(外盘) market.

```bash
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs info '{"token":"<contractAddress>","wallet":"<bscAddress>"}'
```

`data.isAgentIdExclusive` (on-chain identity), `data.market` (`inner` / `outer`), `data.curve` (phase, raise
progress, remaining supply) and `data.route` decide what to do (full output: section 9):

| `route` | Meaning | Do this |
|---|---|---|
| `contract-call` | Agent ID exclusive and on the bonding curve (`Trading`) | "Before migration: buy" / "Before migration: sell" below |
| `market-order` | Migrated (`market: outer`), or not an Agent ID exclusive token | "After migration: market order" below. **Do not** use the script or `contract-call` |
| `wait` | Migration in progress | Tell the user trading is paused while the token migrates; re-run `info` later. Do not fall back to anything |
| `unavailable` | Paused, preset inactive, or not yet / no longer tradable | Tell the user the token is not tradable now, with the `curve.phase` / `curve.paused` values |
| `unsupported` | Not managed by the current Core | This flow does not apply. Re-check the address with the user |

If `route` disagrees with the `meme-rush` row's `migrateStatus`, trust `route` (it is the chain) and say the listing
is stale.

**When `route` is `contract-call`, check Developer Mode now** — before the audit and the quote. Run
`baw wallet settings --json`: if `devMode.enabled` is `false` or `devMode.expiresAt` is in the past, tell the user the
bonding-curve trade needs Developer Mode and how to turn it on ([external-sign.md](external-sign.md#enabling-developer-mode):
Binance App → Agentic Wallet management page → Settings → Developer Mode → confirm the Risk Warning → approve the
signature). Continue only after `wallet settings` shows it on. Do not switch to `market-order` instead.

### Token security audit: on by default, the user may skip it

Run the swap security pre-check in [security.md §1](security.md#1-swap-security-pre-check) as usual. Because these are
Agent ID exclusive launches, **you may offer to skip it — ask, never skip on your own**: e.g. "This is an Agent ID
exclusive launch. Do you want to skip the token security audit for this trade?"

- Offer the skip only when the token came from a `meme-rush` row with `chainId` `56`, `protocol` `2004` and
  `tokenVersion` `openfour.meme.AgentIdExclusive` — not on the user's description or the request parameters alone.
- If the user agrees to skip, say plainly in the trade confirmation that **no token security audit was performed**.
- If the user does not answer clearly, run the audit.

> The Agent ID gate restricts **who may trade** before the token migrates; it is not a vetting of the issuer. The skip
> offer does not generalise — every other launchpad token goes through the standard pre-check with no skip offer.

The trade itself still requires explicit user confirmation — that is a separate control and is never skipped.

**Before confirming a buy, mention the selling restriction.** Until the token migrates it can only be sold by Agent ID
holders (and its issuer) — include this in the confirmation prompt alongside the quote.

### Payment token

If the user named what to buy and how much but not what to pay with: pick a held token with sufficient balance and
proceed, without making it a separate question. If no suitable payment token is available, tell the user to top up or
swap first. Before migration the script accepts **BNB** (default) or the token's quote asset (`data.quote.address`);
any other token must be swapped to BNB first, with its own confirmation.

### Before migration: buy (Developer Mode)

Only when `info` returned `route: "contract-call"`.

**1. Quote and build the transaction.** Pick the mode from the user's wording — "spend 0.05 BNB" → `amount`;
"buy 1,000,000 XYZ" → `tokenAmount`. Both are human-readable decimal strings, never wei: `amount` is the most to
spend, in the pay token (BNB unless `payToken` says otherwise); `tokenAmount` is the number of tokens to buy.

```bash
# spend at most 0.05 BNB
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs quote-buy '{"token":"<contractAddress>","wallet":"<bscAddress>","amount":"0.05"}'
# buy exactly 1,000,000 tokens, paying in BNB
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs quote-buy '{"token":"<contractAddress>","wallet":"<bscAddress>","tokenAmount":"1000000"}'
# spend at most 0.05 BNB with 5% slippage instead of the default 20%
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs quote-buy '{"token":"<contractAddress>","wallet":"<bscAddress>","amount":"0.05","slippageBps":500}'
```

**Slippage: default 20%, the user may change it.** Pass it as `slippageBps`, an integer in basis points: percent ×
100 (20% → `2000`, 5% → `500`, 1% → `100`). If the user named a slippage, use it; if not, the script uses `2000`
(20%) — bonding-curve prices move fast, so a tight default fails often. **Tell the user the slippage
(`slippagePercent`) every time you show a quote and again in the order confirmation**, say whether it is the default,
and that they can choose another value. To change it, re-run `quote-buy` / `quote-sell` with the new value and preview
again; never edit an existing `tx`.

What the slippage bounds — the script writes it into the calldata and Core enforces it on-chain; a trade outside it
reverts with `CoreErrSlippage` and nothing is traded:

| Mode | Bound written into the transaction | Tell the user |
|---|---|---|
| Buy by budget (`amount`) | `minTokenOut = estimate.tokenAmount × (1 − slippage)`; the spend never exceeds `amount` | "You receive at least `minTokenOut`" |
| Buy by token amount (`tokenAmount`) | `pay.maxPay = estimate.userPays × (1 + slippage)`; exactly `estimate.tokenAmount` is bought and any unused part is refunded in the same transaction | "You pay at most `pay.maxPay`" |
| Sell (`quote-sell`) | `minReceive = estimate.userReceives × (1 − slippage)` | "You receive at least `minReceive`" |

The quote already prices this wallet's own trade size at the current block, so slippage only has to cover other
trades that land between the quote and execution. A higher value makes the trade more likely to go through on a busy
curve, at a worse worst-case price.

**Explain the slippage to the user in plain words, with this trade's numbers — when showing the quote and again in
the confirmation.** Cover three things:

1. **What it means here**: the worst case it allows, in tokens or BNB (from the table above).
2. **The trade-off**: a higher slippage fills more easily on a busy curve but allows a worse price; a lower slippage
   protects the price but fails more often when the price moves.
3. **What a failure costs**: if the quote or the preview fails on slippage, nothing is sent and nothing is spent; if
   the transaction is already on-chain and then reverts on slippage, nothing is traded but the gas is still paid.

Templates (fill in the real values; translate to the user's language):

- Buy by budget: "Slippage 20% (default). This quote is about `<estimate.tokenAmount>` `<symbol>`; you are guaranteed
  at least `<minTokenOut>`. If the price moves more than that, the trade fails instead of filling worse. Higher
  slippage fills more easily but you may get fewer tokens; lower slippage protects the price but fails more often,
  and a failed on-chain transaction still costs gas. Tell me if you want another value, e.g. 5%."
- Buy by token amount: "Slippage 20% (default). You buy exactly `<estimate.tokenAmount>` `<symbol>`; it should cost
  about `<estimate.userPays>` BNB and at most `<pay.maxPay>` BNB — anything unused is refunded in the same
  transaction. …(same trade-off and cost sentences)…"
- Sell: "Slippage 20% (default). You should receive about `<estimate.userReceives>` `<receive>`, and at least
  `<minReceive>`. …(same trade-off and cost sentences)…"

Read the result before going further (parameters and fields: section 9):

- `success: false` → handle the error (section 10). Never build a transaction by hand instead.
- Show the quote with its slippage explained as above: `slippagePercent`%, whether it is the default, the bound it sets
  (`minTokenOut` or `pay.maxPay`), the trade-off, and that the user can choose another value.
- `pay.sufficient: false` → the wallet does not hold `pay.maxPay`; tell the user, offer a smaller amount.
- `estimate.budgetNotFullyUsed` / `estimate.tokenAmountClipped` → the cap (or the remaining curve supply) limits the
  buy; tell the user before confirming (section 1).
- `simulation.ok: false` → the transaction would revert now; show `simulation.error.reason` (section 10). For
  `CoreErrSlippage`, tell the user the slippage is too low for the current price movement and suggest a higher value.
- `approveTx` present (paying with the quote asset) → preview, confirm and execute it first, wait for its `receipt`
  → `success`, then re-run `quote-buy`.

**2. Preview with Developer Mode.** Run `data.tx.previewCommand` — it is exactly:

```bash
baw contract-call preview --binanceChainId 56 --from <tx.from> --to <tx.to> --value <tx.value> --inputData <tx.inputData> --json
```

`tx.value` is already in wei; pass `to` / `value` / `inputData` unchanged. Do not pass `--gasLimit` unless the user asks
for one. Preview semantics: [external-sign.md](external-sign.md#contract-call-preview).

**3. Confirm — one combined message.** Show the quote and the preview together: token symbol **and** full
`contractAddress`; spend (`pay.maxPay`, expected `estimate.userPays`); receive (`estimate.tokenAmount`, and
`minTokenOut` for a budget buy); fee (`estimate.totalFee`); slippage explained as above (value, whether it is the
default 20%, the worst case it allows, the trade-off, and that the user can change it);
any cap note; the selling restriction; audit status; and from the preview the balance changes, every
`risks.riskDetails` `title` + `description`, flagged `risks.addresses`, and whether `requireConfirmation` is `true`.

**4. Execute** on a clear "yes":

```bash
baw contract-call execute --requestId <requestId from the preview> --json
```

If execute reports the preview expired, re-run `quote-buy` and preview again, and re-confirm. Then track it (section 6).

**Call out slippage on bonding-curve tokens.** Liquidity is thin and prices move fast. The default 20% lets most trades
through but allows a worse worst-case price — say so, and let the user choose a lower or higher value. If a trade fails
on slippage (`CoreErrSlippage` in the simulation, preview `351805` pointing at slippage, or a `reverted` receipt after
the price moved), tell the user the slippage was too low and suggest increasing it; re-quote with the value they choose.
**Never raise it silently to force a fill.**

### Before migration: sell (Developer Mode)

Only when `info` returned `route: "contract-call"`, and only for Agent ID holders or the issuer (`info` →
`wallet.isIssuer`) — see section 2.

Here `amount` is the number of **tokens to sell** (human-readable, e.g. `"1000000"`), or `"all"` for the whole
holding — not a BNB amount. The proceeds arrive in `receive` (BNB by default).

```bash
# sell 1,000,000 tokens for BNB
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs quote-sell '{"token":"<contractAddress>","wallet":"<bscAddress>","amount":"1000000"}'
# sell the whole holding with 5% slippage instead of the default 20%
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs quote-sell '{"token":"<contractAddress>","wallet":"<bscAddress>","amount":"all","slippageBps":500}'
```

Slippage works as for a buy: default `2000` (20%), `slippageBps` from the user; explain it with the quote and in the
confirmation (sell template above: about `estimate.userReceives`, at least `minReceive`).

Selling takes one or two transactions:

1. **Approval, only when `approveTx` is not `null`.** It approves exactly the sell amount (not unlimited) to Core
   (`contracts.core`). Tell the user up front, run `approveTx.previewCommand`, confirm, execute, and wait for its
   `receipt` → `success`.
2. **Sell.** Re-run `quote-sell` after the approval is mined, then preview → one combined confirmation (amount sold,
   `estimate.userReceives` and `minReceive` in `receive`, fee, preview risks) → execute → track (section 6).

### After migration: market order

When `info` returns `route: "market-order"` the token trades like any DEX token: no Agent ID gate, no cap.

```bash
baw market-order quote --fromTokenQty 0.05 --fromToken 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE --toToken <contractAddress> --binanceChainId 56 --json
```

Show the user the quote (expected output, price impact, fees), then on explicit confirmation:

```bash
baw market-order swap --fromTokenQty 0.05 --fromToken 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE --toToken <contractAddress> --binanceChainId 56 --json
```

Full syntax, slippage, MEV and gas options: [market-order.md](market-order.md).

## 6. Step 4 · Confirm and track

### Before migration (Developer Mode)

`execute` only submits. Do not report success until the receipt says so.

| `execute` → `data.status` | Do this |
|---|---|
| `BROADCASTED` with `txHash` | Run `receipt` until `status` is `success` or `reverted` |
| `PENDING_CONFIRMATION` | Tell the user to approve it in the Binance App, then find the hash with `baw wallet tx-history --type pending --json` (or `baw wallet tx-history --binanceChainId 56 --json`) and run `receipt` |

```bash
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs receipt '{"txHash":"<txHash>"}'
baw wallet balance --tokenAddress <contractAddress> --binanceChainId 56 --json   # resulting balance
```

Report the outcome: `success` → `trades[].tokenAmount` received and `traderQuoteAmount` paid, with the `txHash` (any
unspent BNB was refunded in the same transaction); `reverted` → say it failed on-chain and nothing was traded (gas was
spent), then re-run `info`; still `pending` after ~30 s → say it is still processing, not that it succeeded (see
[speedup-cancel.md](speedup-cancel.md) if it is stuck).

### After migration (market order)

A `success: true` swap response with an `orderId` only means the order was **submitted**, not filled. Follow the
mandatory polling rule in [market-order.md](market-order.md): poll until `status` is `FINISHED` or `FAILED` before
reporting anything as done.

```bash
baw market-order list --orderId <orderId> --json                          # poll until FINISHED / FAILED
baw wallet balance --tokenAddress <contractAddress> --binanceChainId 56 --json   # resulting balance
```

Report the outcome from the terminal status: `FINISHED` → success with `txHash` and the amount received; `FAILED` →
say it failed (`txHash` may be `null`); still `PENDING` after ~30 s → say it is still processing, not that it
succeeded. If the swap was rejected, show the CLI error verbatim — do not rephrase or soften it.

**Partial fill (`FINISHED` with valid, non-empty `refund` entries).** Part of the order was returned. Never report it
as a plain "success" — tell the user all three:

| Tell the user | From the order (`market-order list --orderId`) |
|---|---|
| Spent | `fromTokenQty` `fromTokenName` — already the **actual** amount spent, after the refund |
| Received | `toTokenActualQty` `toTokenName` |
| Refunded | each `refund[].amount` `refund[].symbol` |

Use the symbols exactly as returned (do not derive them from addresses), and do not subtract the refund from
`fromTokenQty` yourself.

- **Do not attribute a refund to the 1% cap here** — after migration there is no cap.
- **No `refund` field does not prove a full fill** — the CLI omits it whenever refund data is missing or unparsable.
  Report the received amount (`toTokenActualQty`); do not claim the order filled in full.

General rule: "Partial fill and `refund`" in [market-order.md](market-order.md).

## 7. Worked example

```bash
# 1. find Agent ID exclusive tokens — pick rankType 10 / 20 / 30 from the user's wording (see section 3)
node <meme-rush-dir>/scripts/cli.mjs meme-rush '{"chainId":"56","rankType":<10|20|30>,"protocol":[2004],"tokenVersionFilter":{"2004":["openfour.meme.AgentIdExclusive"]},"limit":50}'

# 2. pick a row -> take contractAddress. Report progress / holders / netBuy as-is; any null is "unknown"

# 3. check the stage on-chain
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs info '{"token":"<contractAddress>","wallet":"<bscAddress>"}'

# 4a. route "contract-call" (before migration): quote, preview, confirm, execute, track
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs quote-buy '{"token":"<contractAddress>","wallet":"<bscAddress>","amount":"0.05"}'
baw contract-call preview --binanceChainId 56 --from <bscAddress> --to <tx.to> --value <tx.value> --inputData <tx.inputData> --json
baw contract-call execute --requestId <requestId> --json
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs receipt '{"txHash":"<txHash>"}'

# 4b. route "market-order" (after migration): quote, swap on explicit confirmation, poll
baw market-order quote --fromTokenQty 0.05 --fromToken 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE --toToken <contractAddress> --binanceChainId 56 --json
baw market-order swap  --fromTokenQty 0.05 --fromToken 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE --toToken <contractAddress> --binanceChainId 56 --json
baw market-order list --orderId <orderId> --json
```

## 8. Pitfalls

| Pitfall | Consequence | Do this instead |
|---|---|---|
| Using `exclusive: 1` to find these tokens | Returns entirely unrelated tokens | Use `tokenVersionFilter` |
| Omitting `protocol:[2004]` | Other protocols' tokens leak into the result | Always pass both together |
| Treating an empty list as an error | Misleads the user into thinking it is broken | Say "there are none right now" |
| Substituting another sub-type when empty | The user buys something they did not ask for | Any substitution must be stated |
| Matching tokens by `symbol` | Buying the wrong contract — batch launches reuse names | Key on `contractAddress` (enough here — this flow is BSC-only) |
| Reading `null` tax as `0%` | Telling the user a taxed token is tax-free | Show "unknown" |
| Expecting more than 100 rows | `limit` is capped at 100 | Narrow the filters instead |
| Raising slippage to force a fill | The user overpays | Surface the price impact, let the user choose |
| Reporting a rejected order as just "failed" | The user cannot tell what was missing | Explain the Agent ID gate; they can buy after the token migrates |
| Saying "only Agent ID holders can launch" | Misstates the mechanism | Any address can launch; the gate is on **buying and selling** before the token migrates |
| Selling before migration without an Agent ID (non-issuer) | The sell is rejected; looks like a random failure | Only Agent ID holders and the issuer can sell before migration — tell the user to wait until it migrates |
| Reporting "swap succeeded" on the submit response | The order may still fail on-chain | Poll `market-order list --orderId` to `FINISHED` / `FAILED`; for Developer Mode, run `receipt` to `success` / `reverted` |
| Skipping the audit without asking, or on the user's word alone | The user trades an unaudited token unknowingly | Ask first, and only for a returned `AgentIdExclusive` row; say "no audit performed" if skipped |
| Offering the audit skip for other launchpads | The user buys a scam token | The skip offer covers `AgentIdExclusive` only |
| Buying without checking the 1% cap | The user is surprised by a smaller fill | Before migration, read `budgetNotFullyUsed` / `tokenAmountClipped` from `quote-buy` and tell the user before confirming |
| Querying the holding without `--tokenAddress` | Unpriced bonding-curve tokens are hidden, so the holding looks like 0 and the allowance is overstated (e.g. 10M instead of 1M) | Always query with `--tokenAddress <contractAddress>`; a missing token then means 0 |
| Applying the cap after migration | Blocks a buy that has no cap | Check the cap only when `migrateStatus` is `0` |
| Reporting a partially filled order as plain "success" | The user does not know part of their order came back as the pair token | Report spent / received / refunded from `fromTokenQty`, `toTokenActualQty`, `refund[]` |
| Reading "no `refund`" as a full fill, or any refund as the cap | Overstates certainty about the fill and its cause | No `refund` = no refund info; after migration there is no cap |
| Subtracting `refund` from `fromTokenQty` | Understates what the user spent | `fromTokenQty` in the order history is already the actual spend |
| Using `market-order` for a token still on the bonding curve | Wrong route for this stage | `info` → `route: "contract-call"` → script + Developer Mode |
| Using the script / `contract-call` after migration | The script refuses it; the token now trades on a DEX | `info` → `route: "market-order"` |
| Deciding the stage from the `meme-rush` row alone | The token may have migrated since the listing | Always run `info` right before trading |
| Using `amount` when the user named a token quantity (or the reverse) | Buys a different amount than asked | "spend X BNB" → `amount`; "buy N tokens" → `tokenAmount` |
| Hand-building or editing calldata, or converting `tx.value` | Wrong amount or slippage bound, or a revert | Pass `tx.to` / `tx.value` / `tx.inputData` unchanged |
| Running `contract-call execute` without showing the preview | The user signs something they did not see | Show quote + preview + risks, get a clear yes |

## 9. Script reference

`scripts/agent-id-exclusive-token-launches.mjs` is zero-dependency Node (≥ 22) and **read-only**: it never signs or
broadcasts. Every command takes one JSON argument and prints one JSON object — `{"success":true,"rpc":…,"data":{…}}` or
`{"success":false,"rpc":…,"error":{"code":…,"message":…}}`. Exit code `0` = success, `1` = parameter or business
error, `3` = no RPC endpoint reachable. `--help` lists the commands.

```bash
node <skill-dir>/scripts/agent-id-exclusive-token-launches.mjs <command> '<json_params>'
```

| Command | Use it to | Params | Key output |
|---|---|---|---|
| `info` | Check identity and stage, decide the route | `token`, optional `wallet` | `isAgentIdExclusive`, `presetId`, `market`, `route`, `curve`, `wallet` |
| `quote-buy` | Quote a bonding-curve buy and build the transaction | `token`, `wallet`, `amount` (budget) **or** `tokenAmount`, optional `payToken` (`"BNB"` or the quote asset address), `slippageBps` (default `2000` = 20%) | `mode`, `pay`, `estimate`, `minTokenOut` (budget), `slippagePercent`, `approveTx`, `tx` (+ `previewCommand`), `simulation` |
| `quote-sell` | Quote a bonding-curve sell and build the transaction | `token`, `wallet`, `amount` or `"all"`, optional `receive` (`"BNB"` / `"WBNB"` / `"QUOTE"`), `slippageBps` (default `2000` = 20%) | `sell`, `estimate`, `minReceive`, `slippagePercent`, `approveTx`, `tx`, `simulation` |
| `receipt` | Confirm a submitted transaction | `txHash` | `status` (`success` / `reverted` / `pending`), `trades[]` |

**Units.** Every amount you pass in is a human-readable decimal string (`"0.05"`, `"1000000"`), never wei. The
script converts using each token's decimals.

| Field | Unit |
|---|---|
| `quote-buy` `amount` | Most to spend, in the pay token: **BNB** by default (`"0.05"` = 0.05 BNB); the quote asset when `payToken` is its address (`"10"` = 10 USDT for a USDT-quoted token) |
| `quote-buy` `tokenAmount` | Tokens to buy (`"1000000"` = 1,000,000 tokens) |
| `quote-sell` `amount` | Tokens to sell (`"1000000"`), or `"all"` |
| `slippageBps` | Basis points, an integer: percent × 100 (`2000` = 20%, `500` = 5%). Set by the user; default `2000` (20%). Output `slippagePercent` is the same value as a percent (`"20"`) |
| Output `pay.maxPay`, `estimate.userPays`, `pay.balance` | `pay.symbol` (BNB by default), human-readable |
| Output `estimate.tokenAmount`, `minTokenOut`, `sell.amount` | Tokens, human-readable |
| Output `estimate.totalFee` | `estimate.totalFeeSymbol` (the quote asset), human-readable |
| Output `estimate.userReceives`, `minReceive` | The `receive` asset (BNB by default), human-readable |
| Output `*Raw` fields and `tx.value` | Smallest unit (wei for BNB). Pass `tx.value` to `contract-call preview` unchanged |

Every command also accepts `rpc` (a BSC RPC URL); the `BSC_RPC_URL` environment variable works too.

`info` output (abridged):

```json
{
  "isAgentIdExclusive": true,
  "presetId": "1778027615735",
  "market": "inner",
  "route": "contract-call",
  "curve": {
    "phase": { "code": 1, "name": "Trading" },
    "paused": false,
    "totalRaised": "0.004894812224199902",
    "raiseTarget": "13.5",
    "raisedPercent": "0.03",
    "remainingForSale": "798864155.801302913041544864",
    "migrateModuleTag": "module.migrate.pcs_v2"
  },
  "block": 129462383,
  "wallet": { "isIssuer": false, "bnbBalance": "0.25", "tokenBalance": "0" }
}
```

- `isAgentIdExclusive` is `true` when the token's `presetId` is `1778027615735` (the Binance Agent ID preset). This
  on-chain answer is authoritative; the `meme-rush` `tokenVersion` is the discovery label.
- `market`: `inner` = still on the bonding curve (including while migrating), `outer` = migrated to a DEX
  (`curve.migrateModuleTag` names the target).
- `curve.raisedPercent` = `totalRaised / raiseTarget` in the quote asset; it can differ slightly from the `meme-rush`
  `progress`.

How it works (for reviewers):

- Reads Core and Tools from the Registry on BSC (`0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94`), so contract upgrades are
  picked up automatically.
- `quote-buy` / `quote-sell` refuse anything that is not an Agent ID exclusive token in `Trading`
  (`NOT_AGENT_ID_EXCLUSIVE` / `NOT_ON_BONDING_CURVE`).
- Quotes via the Tools estimate functions with the user's wallet as `trader`, so the Agent ID gate, the cap and all
  fees are included. It builds Core `buyByBudget` / `buy` / `sell` with the slippage bound, then simulates the exact
  transaction from the wallet.
- When a buy quote is 0, a zero-value simulation names the cause (`diagnosis`).
- All reads go through Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`), pinned to one block per run
  (`data.block`).
- RPC: the BSC mainnet endpoints from the
  [BNB Chain JSON-RPC list](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/), tried
  in order (rate-limited to 10K requests / 5 min).

## 10. Errors and how to resolve them

Show the user the raw error or reason, then act as below. Never retry by hand-editing calldata or by switching route
silently.

| Error | Cause | Resolution |
|---|---|---|
| `NOT_AGENT_ID_EXCLUSIVE` | Not an Agent ID exclusive token | This flow does not apply; normal `market-order` (standard audit, no skip offer) |
| `NOT_ON_BONDING_CURVE` | The token is not in `Trading`; `error.route` says why | `market-order` → after migration; `wait` → retry later; `unavailable` / `unsupported` → not tradable here |
| `NOT_EXECUTABLE`, diagnosis `NO_AGENT_ID` | The wallet has no Binance Agent ID | They need an Agent ID to buy before migration, or can buy after it |
| `NOT_EXECUTABLE`, diagnosis `HOLDING_CAP_REACHED` | The wallet already holds 10,000,000 tokens | They can buy more after migration |
| `NOT_EXECUTABLE`, diagnosis `TRADE_REJECTED` | Rejected for a reason the script does not recognise | Show the raw `selector` and reason; do not guess or retry |
| `NOT_EXECUTABLE`, `gatePassed: true` | The amount is too small, or the curve supply is exhausted | Try a larger amount; check `curve.remainingForSale` |
| `NOT_EXECUTABLE` (quote-sell) | The wallet may not sell before migration | It can be sold after migration (or once they hold an Agent ID) |
| `INSUFFICIENT_TOKEN_BALANCE` | Sell amount above the holding | Use the reported balance or `"all"` |
| `UNSUPPORTED_PAY_TOKEN` | Pay token is neither BNB nor the quote asset | Pay with BNB, or swap to BNB first with the user's confirmation |
| `ZAP_UNAVAILABLE` | BNB cannot be converted to the quote asset | Pay / receive in the quote asset (`payToken` = quote address, `receive: "QUOTE"`) |
| `INVALID_PARAM` | Bad address, amount, slippage, or both / neither of `amount` and `tokenAmount` | Fix the parameter |
| `RPC_UNAVAILABLE` (exit `3`) / `RPC_ERROR` | No BSC endpoint reachable, rate-limited, or a node error | Retry shortly, or pass another BSC mainnet RPC as `rpc` |
| `simulation.ok: false`, `insufficient BNB for value + gas` | The wallet cannot cover `tx.value` plus gas | Smaller amount or top up |
| `simulation.ok: false`, `CoreErrSlippage` | The price moved past the slippage bound | Tell the user the slippage (`slippagePercent`%) is too low and suggest a higher value; re-quote with the value they choose. Never raise it silently |
| `simulation.ok: false`, `CoreErrBadPhase` | The phase changed (e.g. the curve just completed) | Re-run `info` and follow the new `route` |
| `simulation.ok: false`, `ERC20: insufficient allowance` | Approval missing | Execute `approveTx`, then re-quote |
| `simulation.ok: null` | Not simulated (`APPROVE_REQUIRED` or `SIMULATION_UNAVAILABLE`) | Do the approval first; otherwise the `contract-call preview` simulation still applies |
| `devMode.enabled: false`, or `351801` / `351802` | Developer Mode is not enabled / has expired | Tell the user how to enable it in the Binance App on their phone: Agentic Wallet management page → Settings → Developer Mode → confirm the Risk Warning → approve the signature ([external-sign.md](external-sign.md#enabling-developer-mode)). Re-check `wallet settings` after they do. Do not silently fall back to `market-order` before migration |
| `351804` | The wallet's total balance exceeds the Developer Mode balance cap (the message shows both values, in USDT); Developer Mode has been switched off automatically | Tell the user Developer Mode was disabled because the balance is above the cap; they need to bring the balance under it and re-enable Developer Mode in the Binance App on their phone (Agentic Wallet management page → Settings; see [wallet-setting.md](wallet-setting.md#changing-settings)) |
| `351818` | The transaction needs App confirmation, but the wallet auto-rejects such transactions | Tell the user to switch risky-transaction handling to require confirmation in the Binance App on their phone (Agentic Wallet management page → Settings; see [wallet-setting.md](wallet-setting.md#changing-settings)), then preview again |
| Preview `351805` | The backend simulation failed (stale price, slippage, phase change, gate) | Read the message; re-run `info` + `quote-*` and preview again. If the new quote's simulation fails with `CoreErrSlippage`, suggest a higher slippage |
| Preview `351803` `AGENT_DEV_MODE_RISK_BLOCKED` | Blocked by risk control | Do **not** execute (no `requestId`); show `blockReason` and stop |
| Preview `351821` | Invalid `--gasLimit` | Omit `--gasLimit` unless the user asked for one (21000–15000000) |
| `351806` / `351820` / `351819` | Preview expired / the confirmation window passed / the risk status changed after preview | Re-quote, preview again, re-confirm |
| `351807` Developer Mode daily limit reached (preview or execute) | The trade would exceed `devMode.dailyLimit` (USDT) | Show the raw error and `developerModeQuotaUsed` vs `devMode.dailyLimit` from `wallet settings`. Tell the user to raise the Developer Mode limit manually in the Binance App on their phone (Agentic Wallet management page → Settings; see [wallet-setting.md](wallet-setting.md#changing-settings)); it cannot be changed through the CLI. The App offers 1,000 / 5,000 / 10,000 / 50,000 USDT. Preview again after they adjust it, or offer a smaller amount |
| `receipt` → `reverted` | State changed between preview and mining — most often the price moved past the slippage bound | Report the failure with `txHash` (nothing was traded, gas was spent). If the user wants to retry, re-run `info` and re-quote; suggest a higher slippage if the price has moved |
