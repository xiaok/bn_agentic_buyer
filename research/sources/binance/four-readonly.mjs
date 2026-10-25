#!/usr/bin/env node
// agent-id-exclusive-token-launches CLI — check, quote and build calldata for Binance Agent ID exclusive
// bonding-curve trades on BSC. Self-contained, zero-dep, Node >= 22. Read-only: it only runs
// eth_call / eth_blockNumber / eth_getTransactionReceipt against a BSC node. It never signs or broadcasts —
// the built transaction is executed with `baw contract-call preview` / `execute` (Developer Mode).
//
// Usage: node agent-id-exclusive-token-launches.mjs <command> '<json_params>'
//
// Commands:
//   info        Is it an Agent ID exclusive token? Bonding curve (inner) or DEX (outer)? Curve state and trade route
//   quote-buy   Quote a buy by spend budget (buyByBudget) or by exact token amount (buy) and build calldata
//   quote-sell  Quote a sell by token amount and build sell calldata (+ approve if needed)
//   receipt     Check a submitted transaction and decode its TradeExecuted event
//
// quote-buy / quote-sell only proceed for an Agent ID exclusive token that is still on the bonding curve
// (phase Trading); anything else is refused with the route to use instead.
//
// Reads are batched through Multicall3 and pinned to one block per run, so every value in the output
// comes from the same chain state.
//
// RPC: defaults to the BSC mainnet endpoints listed at
//   https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/
// tried in order. Override with the `rpc` param or the BSC_RPC_URL environment variable.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---- constants ----
const TIMEOUT_MS = 10_000;
const CHAIN_ID_HEX = '0x38'; // BSC mainnet
const BINANCE_CHAIN_ID = '56';
const DEFAULT_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed-public.bnbchain.org',
  'https://bsc-dataseed.nariox.org',
  'https://bsc-dataseed.defibit.io',
  'https://bsc-dataseed.ninicoin.io',
  'https://bsc.nodereal.io',
  'https://rpc-bnb.blockmachine.io',
];
// Registry on BSC; Core and Tools are read from it so governance upgrades are picked up.
const REGISTRY = '0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94';
// Multicall3 (same address on every EVM chain).
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO = '0x0000000000000000000000000000000000000000';
const DEFAULT_SLIPPAGE_BPS = 2000n; // 20%: bonding-curve prices move fast; the user may pass a lower or higher value
const BPS = 10_000n;
const MAX_UINT255 = (1n << 255n) - 1n;

// Agent ID exclusive identity: the preset used by Binance Agent ID launches (same id as the
// reference buy script).
const AGENT_ID_PRESET_ID = 1778027615735n;

// Trade options bits
const OPT_RECEIVE_WRAPPED_NATIVE = 1n; // bit0: sell → keep WBNB instead of unwrapping
const OPT_ZAP_NATIVE = 2n;             // bit1: non-WBNB quote ↔ native through Core's ZapRouter

const SEL = {
  aggregate3: '0x82ad56cb',          // Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[])
  getEthBalance: '0x4d2301cc',       // Multicall3.getEthBalance(address)
  registryCore: '0x7ba9413c',
  registryTools: '0xe75dfb3c',
  tokens: '0xe4860339',
  wrappedNative: '0xeb6d3a11',
  zapRouter: '0x2b7b6e08',
  tokenPhase: '0x51d1b100',          // on the token itself; mirrors vault.phase()
  descriptor: '0x303e74df',          // ITagDescriptor: (bytes8 tagId, string tag, string version)
  phase: '0xb1c9fe6e',
  totalRaised: '0xc5c4744c',
  remainingForSale: '0x13e4930d',
  isPresetActive: '0x3c3ef33c',
  estimateBuy: '0x43cb095f',         // (address token, address trader, uint256 amount, uint256 options, bytes proof)
  estimateBuyByBudget: '0x1f8fcbf6', // (address token, address trader, uint256 maxPay, uint256 options, bytes proof)
  estimateSell: '0x92c0e994',        // (address token, address trader, uint256 amount, uint256 options, bytes proof)
  buy: '0x247d525e',                 // (address token, uint256 amount, uint256 maxQuotePay, uint256 options, bytes proof)
  buyByBudget: '0x995ee6da',         // (address token, uint256 maxQuotePay, uint256 minAmountOut, uint256 options, bytes proof)
  sell: '0x8bfc7764',                // (address token, uint256 amount, uint256 minQuoteRecv, uint256 options, bytes proof)
  approve: '0x095ea7b3',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
};
const TOPIC_TRADE_EXECUTED = '0x8728ba77a8dc0cbf185f23fe65b61fc658a37975e027062c3114394222a10f3f';

const PHASES = ['Created', 'Trading', 'MigratePending', 'Migrated', 'Terminal', 'SoldOut'];

// Revert selectors. Core errors come from the Core ABI. The Agent ID trade-module errors have no
// public ABI; their meaning comes from the reference buy script and was reproduced on a BSC fork.
const GATE_ERRORS = {
  '0x96ea0b74': 'NO_AGENT_ID: before migration only wallets holding a Binance Agent ID can buy (and only Agent ID holders or the issuer can sell)',
  '0xe8c402c1': 'HOLDING_CAP_REACHED: the wallet already holds the per-address cap (1% of max supply)',
  '0x687d0d11': 'HOLDING_CAP_REACHED: the wallet already holds the per-address cap (1% of max supply)',
};
const ERRORS = {
  ...GATE_ERRORS,
  '0xd15b1d74': 'CoreErrBudgetNotExecutable: the budget cannot buy any token for this trader (gate, cap, or budget too small)',
  '0x09d703a0': 'CoreErrSlippage: the price moved beyond the slippage bound — ask the user to raise slippageBps, then re-quote',
  '0xc4e60bf5': 'CoreErrBadPhase: the token is not in the Trading phase — run `info` and switch route',
  '0x8719135f': 'CoreErrTokenPaused: the token is paused',
  '0xa882a63e': 'CoreErrPresetInactive: the token preset is inactive',
  '0x48f383b0': 'CoreErrTokenNotFound: token not managed by Core',
  '0x57896ebc': 'CoreErrTradeRejected: the trade module rejected the trade',
  '0xf6c76ebb': 'CoreErrTradeMax: amount above the trade module maximum',
  '0x3d92fd97': 'CoreErrTradeMin: amount below the trade module minimum',
  '0x3d35bf31': 'CoreErrCurveRejected: the bonding curve rejected the trade',
  '0x6e144a9f': 'CoreErrInsufficientNative: BNB value too low for the trade',
  '0x40b1c62c': 'CoreErrNativeOnlyWrapped: BNB value sent for a non-native quote path',
  '0x71f327bb': 'CoreErrNativeRefundFailed: Core could not refund unused BNB',
  '0xe1979f35': 'CoreErrBadConfig: Core configuration (e.g. ZapRouter route) is not usable',
};

// ---- small utils ----
const fail = (code, message, extra = {}, exitCode = 1) =>
  Object.assign(new Error(message), { code, extra, exitCode });

const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const lc = (a) => String(a ?? '').toLowerCase();

function requireAddress(p, key) {
  if (!isAddress(p[key])) throw fail('INVALID_PARAM', `\`${key}\` must be a 0x-prefixed 20-byte address`);
  return lc(p[key]);
}

function parseUnits(value, decimals, key) {
  const s = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw fail('INVALID_PARAM', `\`${key}\` must be a positive decimal string, e.g. "0.05"`);
  const [int, frac = ''] = s.split('.');
  if (frac.length > decimals) throw fail('INVALID_PARAM', `\`${key}\` has more than ${decimals} decimal places`);
  const raw = BigInt(int + frac.padEnd(decimals, '0'));
  if (raw === 0n) throw fail('INVALID_PARAM', `\`${key}\` must be greater than 0`);
  return raw;
}

function formatUnits(raw, decimals) {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${int}.${frac}` : int);
}

function parseSlippage(p) {
  if (p.slippageBps == null) return DEFAULT_SLIPPAGE_BPS;
  const n = Number(p.slippageBps);
  if (!Number.isInteger(n) || n < 0 || n >= 10_000) throw fail('INVALID_PARAM', '`slippageBps` must be an integer in [0, 9999]');
  return BigInt(n);
}

const slipDown = (x, bps) => (x * (BPS - bps)) / BPS;
const slipUp = (x, bps) => (x * (BPS + bps)) / BPS;
// Percentage with 2 decimals as a string, e.g. 3626n/10000n → "36.26"
const percent = (num, den) => (den === 0n ? null : formatUnits((num * 10_000n) / den, 2));

// ---- ABI encode / decode (only the shapes this CLI needs) ----
const strip = (hex) => hex.replace(/^0x/, '');
const word = (hex) => strip(hex).padStart(64, '0');
const encAddr = (a) => word(lc(a));
const encUint = (n) => word(BigInt(n).toString(16));
// Encodes static args followed by one trailing dynamic `bytes` arg (always empty here: proof = 0x).
const encWithEmptyBytes = (selector, staticWords) =>
  selector + staticWords.join('') + encUint(32 * (staticWords.length + 1)) + encUint(0);

function words(hex) {
  const h = strip(hex);
  const out = [];
  for (let i = 0; i < h.length; i += 64) out.push(BigInt('0x' + h.slice(i, i + 64)));
  return out;
}
const wordAddr = (w) => '0x' + w.toString(16).padStart(40, '0');
const firstWord = (hex) => BigInt('0x' + strip(hex).slice(0, 64));

// Decodes the ABI string whose offset is stored in head slot `slot` of an encoded return value.
function decodeStringAt(hex, slot = 0) {
  const h = strip(hex);
  if (h.length < (slot + 2) * 64) return null;
  const off = Number(BigInt('0x' + h.slice(slot * 64, slot * 64 + 64))) * 2;
  const len = Number(BigInt('0x' + h.slice(off, off + 64)));
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), 'hex').toString('utf8');
}

function decodeRevert(data) {
  if (!data || typeof data !== 'string' || data.length < 10) return { selector: null, reason: 'reverted without data' };
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === '0x08c379a0') return { selector, reason: decodeStringAt('0x' + data.slice(10)) };
  return { selector, reason: ERRORS[selector] ?? 'unknown custom error' };
}

// aggregate3((address target, bool allowFailure, bytes callData)[] calls)
function encAggregate3(calls) {
  const tuples = calls.map(({ to, data }) => {
    const d = strip(data);
    const padded = d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    return encAddr(to) + encUint(1) + encUint(96) + encUint(d.length / 2) + padded;
  });
  const offsets = [];
  let off = 32 * tuples.length;
  for (const t of tuples) { offsets.push(encUint(off)); off += t.length / 2; }
  return SEL.aggregate3 + encUint(32) + encUint(tuples.length) + offsets.join('') + tuples.join('');
}

// returns (bool success, bytes returnData)[] → [{ success, data }]
function decAggregate3(hex) {
  const h = strip(hex);
  const at = (byteOff) => Number(BigInt('0x' + h.slice(byteOff * 2, byteOff * 2 + 64)));
  const arr = at(0);
  const n = at(arr);
  const base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + at(base + 32 * i);
    const dataOff = t + at(t + 32);
    const len = at(dataOff);
    out.push({ success: at(t) === 1, data: '0x' + h.slice((dataOff + 32) * 2, (dataOff + 32 + len) * 2) });
  }
  return out;
}

// ---- JSON-RPC with endpoint failover; all reads pinned to one block ----
const rpcState = { url: null, candidates: DEFAULT_RPCS, block: 'latest' };

async function post(url, method, params) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Pin one endpoint and one block per run so every read comes from the same chain state.
async function selectRpc() {
  const tried = [];
  for (const url of rpcState.candidates) {
    try {
      const r = await post(url, 'eth_chainId', []);
      if (r.result !== CHAIN_ID_HEX) { tried.push(`${url}: chainId ${r.result ?? JSON.stringify(r.error)}`); continue; }
      const b = await post(url, 'eth_blockNumber', []);
      if (!b.result) { tried.push(`${url}: eth_blockNumber ${JSON.stringify(b.error)}`); continue; }
      rpcState.url = url;
      rpcState.block = b.result;
      return;
    } catch (e) {
      tried.push(`${url}: ${e.message}`);
    }
  }
  throw fail('RPC_UNAVAILABLE', 'No BSC RPC endpoint responded', { tried }, 3);
}

async function rpc(method, params) {
  let r;
  try { r = await post(rpcState.url, method, params); }
  catch (e) { throw fail('RPC_UNAVAILABLE', `${method} failed on ${rpcState.url}: ${e.message}`, {}, 3); }
  if (r.error) throw Object.assign(new Error(r.error.message), { rpcError: r.error });
  return r.result;
}

const ethCall = (to, data, extra = {}) => rpc('eth_call', [{ to, data, ...extra }, rpcState.block]);

// Batches read calls in one eth_call. Returns each result's data, or null where that call reverted.
async function multicall(calls) {
  const res = decAggregate3(await ethCall(MULTICALL3, encAggregate3(calls)));
  return res.map((r) => (r.success ? r.data : null));
}

// Simulates the exact transaction the wallet will send; returns { ok } or { ok:false, error }.
async function simulate(tx) {
  try {
    await ethCall(tx.to, tx.inputData, { from: tx.from, value: '0x' + BigInt(tx.value).toString(16) });
    return { ok: true };
  } catch (e) {
    if (!e.rpcError) throw e;
    const msg = e.rpcError.message ?? '';
    if (/insufficient funds/i.test(msg)) return { ok: false, error: { selector: null, reason: 'insufficient BNB for value + gas', raw: msg } };
    // A node-side failure (pruned state, rate limit) is not a revert: the outcome is unknown.
    if (e.rpcError.data == null && !/revert/i.test(msg)) return { ok: null, skipped: `SIMULATION_UNAVAILABLE: ${msg}` };
    return { ok: false, error: { ...decodeRevert(e.rpcError.data), raw: msg } };
  }
}

// The trade module checks the trader before any payment, so a zero-value buy of one token surfaces
// the exact gate error (no Agent ID / cap reached). A payment-stage revert (a known Core error or a
// revert string) means the gate passed; any other custom error is an unrecognised module rejection.
async function diagnoseBuyGate(ctx, wallet) {
  const data = encWithEmptyBytes(SEL.buy, [encAddr(ctx.token.address), encUint(10n ** BigInt(ctx.token.decimals)), encUint(MAX_UINT255), encUint(0)]);
  try {
    await ethCall(ctx.core, data, { from: wallet });
  } catch (e) {
    if (!e.rpcError) throw e;
    const { selector, reason } = decodeRevert(e.rpcError.data);
    if (GATE_ERRORS[selector]) return { gatePassed: false, selector, reason };
    if (selector && selector !== '0x08c379a0' && !ERRORS[selector]) {
      return { gatePassed: false, selector, reason: 'TRADE_REJECTED: the trade module rejected this wallet for a reason this CLI does not recognise' };
    }
  }
  return { gatePassed: true, selector: null, reason: 'Agent ID gate passed for this wallet; the amount is probably too small, or the remaining curve supply is exhausted' };
}

// ---- on-chain reads ----
const erc20Meta = (address, decHex, symHex) => ({
  address,
  decimals: Number(firstWord(decHex)),
  symbol: symHex ? decodeStringAt(symHex) : null,
});

// Loads everything the commands need in three batched rounds (Registry → Core/token → vault/quote/wallet).
async function loadContext(token, wallet = null) {
  const [coreHex, toolsHex] = await multicall([
    { to: REGISTRY, data: SEL.registryCore },
    { to: REGISTRY, data: SEL.registryTools },
  ]);
  if (!coreHex || !toolsHex) throw fail('RPC_ERROR', 'Could not read Core / Tools from the Registry');
  const core = wordAddr(firstWord(coreHex));
  const tools = wordAddr(firstWord(toolsHex));

  const [cfgHex, wnHex, zapHex, tokenPhaseHex, tokenDecHex, tokenSymHex] = await multicall([
    { to: core, data: SEL.tokens + encAddr(token) },
    { to: core, data: SEL.wrappedNative },
    { to: core, data: SEL.zapRouter },
    { to: token, data: SEL.tokenPhase },
    { to: token, data: SEL.decimals },
    { to: token, data: SEL.symbol },
  ]);
  if (!cfgHex || !wnHex || !zapHex) throw fail('RPC_ERROR', 'Could not read the token config from Core');
  // tokens(address) returns 20 values; head slots 4/5 are string offsets (name/symbol), not needed here.
  const w = words(cfgHex);
  const cfg = {
    creator: wordAddr(w[1]),
    presetId: w[2],
    maxSupply: w[6],
    saleAmount: w[7],
    raiseAmount: w[8],
    quoteAsset: wordAddr(w[9]),
    vault: wordAddr(w[10]),
    migrateModule: wordAddr(w[13]),
    exists: w[17] === 1n,
    paused: w[18] === 1n,
  };
  const wrappedNative = wordAddr(firstWord(wnHex));
  const zapRouter = wordAddr(firstWord(zapHex));
  if (!cfg.exists) {
    return { core, tools, exists: false, route: 'unsupported', market: null, isAgentIdExclusive: false };
  }
  if (!tokenDecHex) throw fail('RPC_ERROR', 'Could not read the token decimals');

  const calls = [
    { to: cfg.vault, data: SEL.totalRaised },
    { to: cfg.vault, data: SEL.remainingForSale },
    { to: REGISTRY, data: SEL.isPresetActive + encUint(cfg.presetId) },
    { to: cfg.quoteAsset, data: SEL.decimals },
    { to: cfg.quoteAsset, data: SEL.symbol },
    { to: cfg.migrateModule, data: SEL.descriptor },
    // Fallback only: every token checked exposes tokenPhase(), equal to vault.phase().
    { to: cfg.vault, data: SEL.phase },
  ];
  if (wallet) {
    calls.push(
      { to: MULTICALL3, data: SEL.getEthBalance + encAddr(wallet) },
      { to: token, data: SEL.balanceOf + encAddr(wallet) },
      { to: token, data: SEL.allowance + encAddr(wallet) + encAddr(core) },
      { to: cfg.quoteAsset, data: SEL.balanceOf + encAddr(wallet) },
      { to: cfg.quoteAsset, data: SEL.allowance + encAddr(wallet) + encAddr(core) },
    );
  }
  const r = await multicall(calls);
  const [raisedHex, remainingHex, activeHex, quoteDecHex, quoteSymHex, migrateDescHex, vaultPhaseHex] = r;
  const phaseHex = tokenPhaseHex ?? vaultPhaseHex;
  if (!raisedHex || !remainingHex || !activeHex || !quoteDecHex || !phaseHex) {
    throw fail('RPC_ERROR', 'Could not read the bonding-curve state from the vault');
  }

  const tokenMeta = erc20Meta(token, tokenDecHex, tokenSymHex);
  const quoteMeta = erc20Meta(cfg.quoteAsset, quoteDecHex, quoteSymHex);
  const phase = Number(firstWord(phaseHex));
  const totalRaised = firstWord(raisedHex);
  const remainingForSale = firstWord(remainingHex);
  const presetActive = firstWord(activeHex) === 1n;
  const quoteIsWrappedNative = lc(cfg.quoteAsset) === lc(wrappedNative);
  const isAgentIdExclusive = cfg.presetId === AGENT_ID_PRESET_ID;

  // Inner market = bonding curve (incl. migrating); outer market = migrated DEX pool.
  const market = phase === 3 ? 'outer' : 'inner';

  // Route: Agent ID token on the curve → contract-call via this CLI; migrated, or any other
  // token → normal market-order; migrating → wait.
  let route;
  if (phase === 3) route = 'market-order';
  else if (phase === 2 || phase === 5) route = 'wait';
  else if (phase === 1 && !cfg.paused && presetActive) route = isAgentIdExclusive ? 'contract-call' : 'market-order';
  else route = 'unavailable';

  const walletState = wallet
    ? {
        bnbBalance: firstWord(r[7]),
        tokenBalance: firstWord(r[8]),
        tokenAllowanceToCore: firstWord(r[9]),
        quoteBalance: firstWord(r[10]),
        quoteAllowanceToCore: firstWord(r[11]),
      }
    : null;

  return {
    core, tools, exists: true, route, market, isAgentIdExclusive, wrappedNative, zapRouter, walletState,
    token: tokenMeta,
    quote: { ...quoteMeta, isWrappedNative: quoteIsWrappedNative },
    creator: cfg.creator,
    presetId: cfg.presetId.toString(),
    curve: {
      phase: { code: phase, name: PHASES[phase] ?? 'Unknown' },
      paused: cfg.paused,
      presetActive,
      totalRaised: formatUnits(totalRaised, quoteMeta.decimals),
      raiseTarget: formatUnits(cfg.raiseAmount, quoteMeta.decimals),
      raisedPercent: percent(totalRaised, cfg.raiseAmount),
      remainingForSale: formatUnits(remainingForSale, tokenMeta.decimals),
      saleAmount: formatUnits(cfg.saleAmount, tokenMeta.decimals),
      maxSupply: formatUnits(cfg.maxSupply, tokenMeta.decimals),
      migrateModuleTag: migrateDescHex ? decodeStringAt(migrateDescHex, 1) : null,
    },
    vault: cfg.vault,
  };
}

function summary(ctx) {
  return {
    token: ctx.token, quote: ctx.quote, creator: ctx.creator,
    isAgentIdExclusive: ctx.isAgentIdExclusive,
    presetId: ctx.presetId,
    market: ctx.market,
    route: ctx.route,
    curve: ctx.curve,
    contracts: { core: ctx.core, tools: ctx.tools, vault: ctx.vault, zapRouter: ctx.zapRouter },
    block: Number(BigInt(rpcState.block)),
  };
}

function routeHint(ctx) {
  switch (ctx.route) {
    case 'contract-call':
      return 'Agent ID exclusive token on the bonding curve — quote with this CLI and execute via `baw contract-call`.';
    case 'market-order':
      return ctx.market === 'outer'
        ? 'Token has migrated to a DEX (outer market) — trade it with `baw market-order`, not this CLI.'
        : 'Not an Agent ID exclusive token — this flow does not apply; trade it with `baw market-order` as usual.';
    case 'wait':
      return 'Migration is in progress (MigratePending / SoldOut) — bonding-curve trading is closed and the DEX pool is not ready; wait and re-run `info`.';
    case 'unavailable':
      return 'Token is not tradable now (paused, preset inactive, Created or Terminal phase).';
    default:
      return 'Token is not managed by the current Core — this flow does not apply.';
  }
}

// quote-buy / quote-sell gate: Agent ID exclusive AND still on the bonding curve.
function requireAgentCurve(ctx) {
  if (ctx.route === 'contract-call') return;
  const extra = { route: ctx.route, market: ctx.market, isAgentIdExclusive: ctx.isAgentIdExclusive, hint: routeHint(ctx), ...(ctx.exists ? summary(ctx) : {}) };
  if (ctx.exists && !ctx.isAgentIdExclusive) throw fail('NOT_AGENT_ID_EXCLUSIVE', routeHint(ctx), extra);
  throw fail('NOT_ON_BONDING_CURVE', routeHint(ctx), extra);
}

const decodeEstimate = (hex) => {
  const [curveQuote, totalFee, userPays, userReceives, tokenAmount, executionPrice] = words(hex);
  return { curveQuote, totalFee, userPays, userReceives, tokenAmount, executionPrice };
};

const previewCommand = (tx) =>
  `baw contract-call preview --binanceChainId ${BINANCE_CHAIN_ID} --from ${tx.from} --to ${tx.to} --value ${tx.value} --inputData ${tx.inputData} --json`;

const txOut = (tx) => ({ ...tx, binanceChainId: BINANCE_CHAIN_ID, previewCommand: previewCommand(tx) });

// ---- commands ----
async function cmdInfo(p) {
  const token = requireAddress(p, 'token');
  const wallet = p.wallet != null ? requireAddress(p, 'wallet') : null;
  const ctx = await loadContext(token, wallet);
  if (!ctx.exists) {
    return { isAgentIdExclusive: false, market: null, route: ctx.route, hint: routeHint(ctx), contracts: { core: ctx.core, tools: ctx.tools } };
  }
  const out = { ...summary(ctx), hint: routeHint(ctx) };
  if (wallet) {
    const s = ctx.walletState;
    out.wallet = {
      address: wallet,
      isIssuer: wallet === lc(ctx.creator),
      bnbBalance: formatUnits(s.bnbBalance, 18),
      tokenBalance: formatUnits(s.tokenBalance, ctx.token.decimals),
      tokenBalanceRaw: s.tokenBalance.toString(),
      tokenAllowanceToCore: s.tokenAllowanceToCore.toString(),
    };
  }
  return out;
}

async function cmdQuoteBuy(p) {
  const token = requireAddress(p, 'token');
  const wallet = requireAddress(p, 'wallet');
  const slippageBps = parseSlippage(p);
  const byBudget = p.amount != null;
  if (byBudget === (p.tokenAmount != null)) {
    throw fail('INVALID_PARAM', 'Pass exactly one of `amount` (spend budget) or `tokenAmount` (exact tokens to buy)');
  }

  const ctx = await loadContext(token, wallet);
  requireAgentCurve(ctx);

  const payToken = lc(p.payToken ?? 'BNB');
  const payNative = payToken === 'bnb' || payToken === NATIVE;
  if (!payNative && payToken !== lc(ctx.quote.address)) {
    throw fail('UNSUPPORTED_PAY_TOKEN',
      `Pay with BNB or with the token's quote asset ${ctx.quote.symbol} (${ctx.quote.address}). Swap other tokens first.`,
      { quote: ctx.quote });
  }
  if (payNative && !ctx.quote.isWrappedNative && ctx.zapRouter === ZERO) {
    throw fail('ZAP_UNAVAILABLE', `Core has no ZapRouter, so BNB cannot be converted to ${ctx.quote.symbol}. Pay with ${ctx.quote.symbol} instead.`, { quote: ctx.quote });
  }

  const payDecimals = payNative ? 18 : ctx.quote.decimals;
  const paySymbol = payNative ? 'BNB' : ctx.quote.symbol;
  // WBNB quote: BNB is wrapped 1:1 by Core. Other quotes: bit1 makes `userPays` native-denominated
  // while `curveQuote` / `totalFee` stay in the quote asset.
  const zap = payNative && !ctx.quote.isWrappedNative;
  const options = zap ? OPT_ZAP_NATIVE : 0n;

  const input = byBudget
    ? parseUnits(p.amount, payDecimals, 'amount')
    : parseUnits(p.tokenAmount, ctx.token.decimals, 'tokenAmount');
  const est = decodeEstimate(await ethCall(ctx.tools, encWithEmptyBytes(
    byBudget ? SEL.estimateBuyByBudget : SEL.estimateBuy,
    [encAddr(token), encAddr(wallet), encUint(input), encUint(options)],
  )));

  if (est.tokenAmount === 0n) {
    const diagnosis = await diagnoseBuyGate(ctx, wallet);
    throw fail('NOT_EXECUTABLE', `The quote returned 0 tokens for this wallet. ${diagnosis.reason}`,
      { ...summary(ctx), wallet, diagnosis });
  }

  // Build the Core call. Budget: buyByBudget with a lower bound on tokens. Exact amount: buy with an
  // upper bound on what is paid (estimate + slippage); Core refunds any unused BNB in the same tx.
  const quoteCost = est.curveQuote + est.totalFee; // always quote-denominated
  let tx, maxPay, minTokenOut = null, maxQuotePay;
  if (byBudget) {
    maxQuotePay = zap ? quoteCost : input;
    minTokenOut = slipDown(est.tokenAmount, slippageBps);
    maxPay = input;
    tx = {
      from: wallet, to: ctx.core, value: (payNative ? input : 0n).toString(),
      inputData: encWithEmptyBytes(SEL.buyByBudget, [encAddr(token), encUint(maxQuotePay), encUint(minTokenOut), encUint(options)]),
    };
  } else {
    maxQuotePay = slipUp(quoteCost, slippageBps);
    maxPay = payNative ? slipUp(est.userPays, slippageBps) : maxQuotePay;
    // Use the quoted (possibly cap-clipped) amount so the calldata states exactly what is bought.
    tx = {
      from: wallet, to: ctx.core, value: (payNative ? maxPay : 0n).toString(),
      inputData: encWithEmptyBytes(SEL.buy, [encAddr(token), encUint(est.tokenAmount), encUint(maxQuotePay), encUint(options)]),
    };
  }

  const s = ctx.walletState;
  const payBalance = payNative ? s.bnbBalance : s.quoteBalance;
  let approveTx = null;
  if (!payNative && s.quoteAllowanceToCore < maxPay) {
    approveTx = txOut({
      from: wallet, to: ctx.quote.address, value: '0',
      inputData: SEL.approve + encAddr(ctx.core) + encUint(maxPay),
    });
  }
  const simulation = approveTx
    ? { ok: null, skipped: 'APPROVE_REQUIRED: execute approveTx first, then re-run quote-buy' }
    : await simulate(tx);

  // Budget mode: a large unspent part usually means the per-address cap or the remaining sale limited
  // the fill; the unspent BNB stays with the user. Exact mode: the cap clips the requested amount.
  const unspent = byBudget && input > est.userPays ? input - est.userPays : 0n;
  return {
    ...summary(ctx),
    wallet,
    mode: byBudget ? 'budget' : 'tokenAmount',
    pay: {
      symbol: paySymbol,
      token: payNative ? NATIVE : ctx.quote.address,
      maxPay: formatUnits(maxPay, payDecimals),
      maxPayRaw: maxPay.toString(),
      balance: formatUnits(payBalance, payDecimals),
      sufficient: payBalance >= maxPay,
    },
    estimate: {
      tokenAmount: formatUnits(est.tokenAmount, ctx.token.decimals),
      tokenAmountRaw: est.tokenAmount.toString(),
      userPays: formatUnits(est.userPays, payDecimals),
      totalFee: formatUnits(est.totalFee, ctx.quote.decimals),
      totalFeeSymbol: ctx.quote.symbol,
      ...(byBudget
        ? { expectedUnspent: formatUnits(unspent, payDecimals), budgetNotFullyUsed: unspent * 1000n > input } // > 0.1 % of budget
        : { requestedTokenAmount: formatUnits(input, ctx.token.decimals), tokenAmountClipped: est.tokenAmount < input }),
    },
    slippageBps: Number(slippageBps),
    slippagePercent: formatUnits(slippageBps, 2), // e.g. "20" = 20%
    ...(byBudget
      ? { minTokenOut: formatUnits(minTokenOut, ctx.token.decimals), minTokenOutRaw: minTokenOut.toString() }
      : {}),
    approveTx,
    tx: txOut(tx),
    simulation,
  };
}

async function cmdQuoteSell(p) {
  const token = requireAddress(p, 'token');
  const wallet = requireAddress(p, 'wallet');
  const slippageBps = parseSlippage(p);
  const ctx = await loadContext(token, wallet);
  requireAgentCurve(ctx);

  const balance = ctx.walletState.tokenBalance;
  const amount = String(p.amount ?? '').toLowerCase() === 'all' ? balance : parseUnits(p.amount, ctx.token.decimals, 'amount');
  if (amount === 0n) throw fail('INSUFFICIENT_TOKEN_BALANCE', 'Wallet holds none of this token', { wallet, token: ctx.token });
  if (amount > balance) {
    throw fail('INSUFFICIENT_TOKEN_BALANCE', `Sell amount exceeds the wallet holding of ${formatUnits(balance, ctx.token.decimals)}`,
      { wallet, token: ctx.token, balance: formatUnits(balance, ctx.token.decimals) });
  }

  const receive = String(p.receive ?? 'BNB').toUpperCase();
  if (!['BNB', 'WBNB', 'QUOTE'].includes(receive)) throw fail('INVALID_PARAM', '`receive` must be BNB, WBNB or QUOTE');
  let options;
  if (ctx.quote.isWrappedNative) options = receive === 'BNB' ? 0n : OPT_RECEIVE_WRAPPED_NATIVE;
  else if (receive === 'QUOTE') options = 0n;
  else {
    if (ctx.zapRouter === ZERO) throw fail('ZAP_UNAVAILABLE', `Core has no ZapRouter; receive ${ctx.quote.symbol} instead (receive: "QUOTE")`, { quote: ctx.quote });
    options = OPT_ZAP_NATIVE | (receive === 'WBNB' ? OPT_RECEIVE_WRAPPED_NATIVE : 0n);
  }
  const receiveNative = options !== 0n || ctx.quote.isWrappedNative;
  const recvDecimals = receiveNative ? 18 : ctx.quote.decimals;
  const recvSymbol = receiveNative ? (receive === 'BNB' ? 'BNB' : 'WBNB') : ctx.quote.symbol;

  // Tools does not check the seller's balance; the balance check above covers that.
  const est = decodeEstimate(await ethCall(ctx.tools,
    encWithEmptyBytes(SEL.estimateSell, [encAddr(token), encAddr(wallet), encUint(amount), encUint(options)])));
  if (est.tokenAmount === 0n) {
    throw fail('NOT_EXECUTABLE',
      'The quote returned 0: this wallet cannot sell before migration. Only Agent ID holders and the token issuer can sell on the bonding curve.',
      { ...summary(ctx), wallet, isIssuer: wallet === lc(ctx.creator) });
  }

  const minReceive = slipDown(est.userReceives, slippageBps);
  const tx = {
    from: wallet,
    to: ctx.core,
    value: '0',
    inputData: encWithEmptyBytes(SEL.sell, [encAddr(token), encUint(amount), encUint(minReceive), encUint(options)]),
  };

  // Approve exactly the sell amount (not unlimited) to Core.
  const approveTx = ctx.walletState.tokenAllowanceToCore < amount
    ? txOut({ from: wallet, to: token, value: '0', inputData: SEL.approve + encAddr(ctx.core) + encUint(amount) })
    : null;
  const simulation = approveTx
    ? { ok: null, skipped: 'APPROVE_REQUIRED: execute approveTx first, wait for it to confirm, then re-run quote-sell' }
    : await simulate(tx);

  return {
    ...summary(ctx),
    wallet,
    sell: { amount: formatUnits(amount, ctx.token.decimals), amountRaw: amount.toString(), balance: formatUnits(balance, ctx.token.decimals) },
    receive: recvSymbol,
    estimate: {
      userReceives: formatUnits(est.userReceives, recvDecimals),
      totalFee: formatUnits(est.totalFee, ctx.quote.decimals),
      totalFeeSymbol: ctx.quote.symbol,
    },
    slippageBps: Number(slippageBps),
    slippagePercent: formatUnits(slippageBps, 2), // e.g. "20" = 20%
    minReceive: formatUnits(minReceive, recvDecimals),
    minReceiveRaw: minReceive.toString(),
    approveTx,
    tx: txOut(tx),
    simulation,
  };
}

async function cmdReceipt(p) {
  const hash = String(p.txHash ?? '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw fail('INVALID_PARAM', '`txHash` must be a 0x-prefixed 32-byte hash');
  const r = await rpc('eth_getTransactionReceipt', [hash]);
  if (!r) return { txHash: hash, status: 'pending', note: 'No receipt yet — not mined (or unknown to this node). Re-check shortly.' };

  // data: isBuy, quoteAsset, vault, requestedTokenAmount, tokenAmount, curveQuoteAmount, traderQuoteAmount,
  //       lastPrice, slippageLimit, protocolFee, taxFee, devFee, antiSniperFee, totalRaised, remainingForSale
  const events = r.logs
    .filter((log) => lc(log.topics[0]) === TOPIC_TRADE_EXECUTED && log.topics.length === 4)
    .map((log) => ({ token: wordAddr(BigInt(log.topics[1])), trader: wordAddr(BigInt(log.topics[2])), d: words(log.data) }));

  // Token + quote metadata for every event in one batch.
  const metaCalls = events.flatMap(({ token, d }) => {
    const quote = wordAddr(d[1]);
    return [
      { to: token, data: SEL.decimals }, { to: token, data: SEL.symbol },
      { to: quote, data: SEL.decimals }, { to: quote, data: SEL.symbol },
    ];
  });
  const meta = metaCalls.length ? await multicall(metaCalls) : [];

  const trades = events.map(({ token, trader, d }, i) => {
    const tokenMeta = erc20Meta(token, meta[4 * i] ?? '0x12', meta[4 * i + 1]);
    const quoteMeta = erc20Meta(wordAddr(d[1]), meta[4 * i + 2] ?? '0x12', meta[4 * i + 3]);
    return {
      token: tokenMeta,
      trader,
      side: d[0] === 1n ? 'BUY' : 'SELL',
      requestedTokenAmount: formatUnits(d[3], tokenMeta.decimals),
      tokenAmount: formatUnits(d[4], tokenMeta.decimals),
      traderQuoteAmount: formatUnits(d[6], quoteMeta.decimals), // buy: quote paid incl. fees; sell: quote received after fees
      totalFee: formatUnits(d[9] + d[10] + d[11] + d[12], quoteMeta.decimals),
      quote: quoteMeta,
    };
  });
  return {
    txHash: hash,
    status: r.status === '0x1' ? 'success' : 'reverted',
    blockNumber: Number(BigInt(r.blockNumber)),
    from: r.from,
    to: r.to,
    gasUsed: BigInt(r.gasUsed).toString(),
    // Network fee actually paid, in BNB
    gasFee: r.effectiveGasPrice ? formatUnits(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice), 18) : null,
    trades,
  };
}

const COMMANDS = { info: cmdInfo, 'quote-buy': cmdQuoteBuy, 'quote-sell': cmdQuoteSell, receipt: cmdReceipt };

// ---- exports (for unit testing; direct execution still works — see dispatch below) ----
export {
  COMMANDS, ERRORS, GATE_ERRORS, SEL, parseUnits, formatUnits, decodeRevert, encWithEmptyBytes,
  encAggregate3, decAggregate3, DEFAULT_RPCS,
};

// ---- CLI dispatch (only runs when executed directly, not when imported) ----
// Compare real paths: skill directories are usually symlinks (e.g. ~/.claude/skills/<name>), and
// import.meta.url resolves the link while process.argv[1] does not.
const isMain = (() => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, paramsStr] = process.argv.slice(2);

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log("Usage: node agent-id-exclusive-token-launches.mjs <command> '<json_params>'\n\nCommands:");
    for (const name of Object.keys(COMMANDS)) console.log(`  ${name}`);
    process.exit(0);
  }

  const handler = COMMANDS[cmd];
  if (!handler) { console.error(`Unknown command: ${cmd}\nRun with --help to see available commands.`); process.exit(1); }

  let params = {};
  if (paramsStr) {
    try { params = JSON.parse(paramsStr); }
    catch { console.error('Invalid JSON params'); process.exit(1); }
  }

  const override = params.rpc ?? process.env.BSC_RPC_URL;
  if (override) rpcState.candidates = [override];

  try {
    await selectRpc();
    const data = await handler(params);
    console.log(JSON.stringify({ success: true, rpc: rpcState.url, data }, null, 2));
  } catch (err) {
    const error = { code: err.code ?? 'ERROR', message: err.message, ...(err.extra ?? {}) };
    if (err.rpcError) Object.assign(error, { code: 'RPC_ERROR', rpcError: err.rpcError });
    console.log(JSON.stringify({ success: false, rpc: rpcState.url, error }, null, 2));
    process.exit(err.exitCode || 1);
  }
}
