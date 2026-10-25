import { encodeFunctionData, decodeAbiParameters, parseAbi, parseAbiParameters } from 'viem';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, ZERO, NATIVE, WBNB, equal, fail, units, down, formatUnits, shareBps, tx, childJson } from './core.mjs';
import { SOFT_ABI, V2_ABI, ERC20_ABI } from './vendor/gang-abi.mjs';

export const ERC20 = ERC20_ABI;
export const WRAPPED = parseAbi(['function deposit() payable', 'function withdraw(uint256 amount)']);
export const FLAP_FACTORY = '0xC55820f24015bE7c4f18949D9e1363A3609B300e';
export const FLAP_PORTAL = '0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062';
export const FLAP_MAIN = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
const flapData = JSON.parse(readFileSync(join(ROOT, 'scripts/vendor/flap-abi.json'), 'utf8'));
export const FLAP = {
  factory: parseAbi(flapData.factoryAbi),
  probe: parseAbi(flapData.marketProbeAbi.concat(['function assetProbe()'])),
  market: parseAbi(flapData.marketAbi),
  portal: parseAbi(flapData.portalAbi.concat(['function buyWithQuote(address market,uint256 grossQuote,uint256 minShares) returns (uint256)'])),
};
const FLAP_TOKEN_STATE = '(uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 buyTaxRate,uint256 sellTaxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId)';
export const FLAP_ORDINARY = parseAbi([
  `function getTokenV8Safe(address token) view returns (${FLAP_TOKEN_STATE} state)`,
  'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount) params) returns (uint256 outputAmount)',
  'function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData) params) payable returns (uint256 outputAmount)',
]);
export const GANG_PADS = [
  { version: 'v2', address: '0x1B8F3f69DFa0a7F63d308C7EB0Fd38D8b099966E', abi: V2_ABI },
  { version: 'soft', address: '0x4E6f13c8A453c1b8b4E20b590082bb233a5b80d7', abi: SOFT_ABI },
  { version: 'u', address: '0xF81C4E51c48466c6025B0165b1Ea0F6978c712cb', abi: V2_ABI },
  { version: 's', address: '0x60aee38576035E757deD30fF8db8A8DA476430C1', abi: V2_ABI },
  { version: 'v4.1', address: '0x315Ba2e8952D06094CC636b2B84229FA32fb23A7', abi: SOFT_ABI },
];
export const read = (client, target, abi, functionName, args = [], extra = {}) => client.readContract({ address: target, abi, functionName, args, ...extra });
export async function metadata(client, token) {
  if (equal(token, ZERO) || equal(token, NATIVE)) return { token: NATIVE, decimals: 18, symbol: 'BNB' };
  const [decimals, symbol] = await Promise.all([read(client, token, ERC20, 'decimals'), read(client, token, ERC20, 'symbol').catch(() => 'TOKEN')]);
  return { token, decimals: Number(decimals), symbol };
}
export const balance = (client, token, wallet) => equal(token, NATIVE) || equal(token, ZERO)
  ? client.getBalance({ address: wallet }) : read(client, token, ERC20, 'balanceOf', [wallet]);

export function errorData(error) {
  const seen = new Set();
  const visit = (e) => {
    if (!e || typeof e !== 'object' || seen.has(e)) return null;
    seen.add(e);
    if (typeof e.data === 'string' && e.data.startsWith('0x08c379a0')) return e.data;
    for (const value of [e.cause, e.data, e.error]) { const data = visit(value); if (data) return data; }
    return null;
  };
  return visit(error);
}
export function parseProbeData(data, required) {
  if (!data?.startsWith('0x08c379a0')) throw fail('UNREADABLE_PROBE', 'Probe 缺少 Error(string)');
  let text;
  try { [text] = decodeAbiParameters(parseAbiParameters('string'), '0x' + data.slice(10)); }
  catch { throw fail('UNREADABLE_PROBE', 'Probe 返回被截断'); }
  if (!text.endsWith(';END')) throw fail('UNREADABLE_PROBE', 'Probe 返回缺少 ;END');
  const fields = {};
  for (const field of text.slice(0, -4).split(';')) {
    const split = field.indexOf('=');
    if (split < 1) throw fail('UNREADABLE_PROBE', text);
    const key = field.slice(0, split);
    if (Object.hasOwn(fields, key)) throw fail('UNREADABLE_PROBE', '重复 Probe 字段');
    fields[key] = field.slice(split + 1);
  }
  if (required.some(key => !Object.hasOwn(fields, key))) throw fail('UNREADABLE_PROBE', 'Probe 缺少必要字段', { fields });
  return fields;
}
export async function probe(client, probeAddress, wallet, functionName, args, required, blockNumber) {
  let error;
  try { await client.call({ account: wallet, to: probeAddress, data: encodeFunctionData({ abi: FLAP.probe, functionName, args }), value: 0n, blockNumber }); }
  catch (e) { error = e; }
  if (!error) throw fail('UNREADABLE_PROBE', 'Probe 未返回预期的 revert 数据');
  const data = errorData(error);
  if (!data) throw fail('PROBE_FAILED', error.shortMessage || error.message);
  return parseProbeData(data, required);
}

export const four = (cfg, command, params) => childJson(process.execPath, [join(ROOT, 'scripts/vendor/four-readonly.mjs'), command, JSON.stringify({ ...params, rpc: cfg.rpcUrl, skipSimulation: true })]);

async function detectFlap(client, input) {
  const [isMarket, mapped] = await Promise.all([
    read(client, FLAP_FACTORY, FLAP.factory, 'isMarket', [input]),
    read(client, FLAP_FACTORY, FLAP.factory, 'marketOfToken', [input]),
  ]);
  const market = isMarket ? input : mapped;
  if (equal(market, ZERO)) return null;
  const [p, registered, portalFactory, marketPortal] = await Promise.all([
    read(client, FLAP_FACTORY, FLAP.factory, 'probeOfMarket', [market]),
    read(client, FLAP_FACTORY, FLAP.factory, 'isMarket', [market]),
    read(client, FLAP_PORTAL, FLAP.portal, 'factory'),
    read(client, market, FLAP.market, 'portal'),
  ]);
  if (!registered || equal(p, ZERO) || !equal(portalFactory, FLAP_FACTORY) || !equal(marketPortal, FLAP_PORTAL)) throw fail('BINDING_MISMATCH', 'Flap 注册绑定不一致');
  const bound = await read(client, p, FLAP.probe, 'market');
  if (!equal(bound, market)) throw fail('BINDING_MISMATCH', 'Flap Probe 绑定不一致');
  return { platform: 'flap', version: 'agent-curve', input, market, probe: p };
}
async function detectGang(client, input) {
  const results = await Promise.allSettled(GANG_PADS.map(async pad => ({ pad, curve: await read(client, pad.address, pad.abi, 'curves', [input]) })));
  const matches = results.filter(x => x.status === 'fulfilled' && !equal(x.value.curve[0], ZERO)).map(x => x.value);
  if (matches.length > 1) throw fail('AMBIGUOUS_PLATFORM', 'Gang 多个分支同时登记此地址');
  if (matches.length) return { platform: 'gang', version: matches[0].pad.version, input, token: input, market: matches[0].pad.address };
  if (results.some(x => x.status === 'rejected')) throw fail('RPC_INCOMPLETE', '无法完整读取 Gang 登记，不能当作不存在');
  return null;
}
export async function detect(client, cfg, input) {
  const results = await Promise.allSettled([
    detectFlap(client, input), detectGang(client, input),
    four(cfg, 'info', { token: input }).then(info => info.isAgentIdExclusive ? { platform: 'four', version: 'agent-id', input, token: input, market: info.contracts.core, info } : null),
  ]);
  const matches = results.filter(x => x.status === 'fulfilled' && x.value).map(x => x.value);
  if (matches.length > 1) throw fail('AMBIGUOUS_PLATFORM', '多个平台登记了此地址，停止交易');
  if (matches.length === 1) return matches[0];
  const errors = results.filter(x => x.status === 'rejected').map(x => x.reason.message);
  if (errors.length) throw fail('RPC_INCOMPLETE', '平台查询失败', { errors });
  throw fail('UNSUPPORTED_TOKEN', '此地址不属于已支持的 Four Agent ID、Flap Agent Curve 或 Gang 合约');
}
export async function state(client, cfg, market) {
  if (market.platform === 'four') {
    const info = await four(cfg, 'info', { token: market.input });
    if (!info.isAgentIdExclusive) throw fail('PLATFORM_CHANGED', 'Four preset 已变化');
    return { ...market, market: info.contracts.core, token: info.token.address, quote: info.quote.address,
      phase: info.route === 'contract-call' ? 'curve' : info.market === 'outer' ? 'dex' : info.route, info };
  }
  if (market.platform === 'gang') {
    const pad = GANG_PADS.find(x => x.version === market.version);
    const c = await read(client, pad.address, pad.abi, 'curves', [market.token]);
    if (equal(c[0], ZERO)) throw fail('UNSUPPORTED_TOKEN', 'Gang 登记不存在');
    const soft = ['soft', 'v4.1'].includes(pad.version);
    return { ...market, phase: c[soft ? 3 : 6] ? 'dex' : 'curve', quote: soft ? NATIVE : c[1],
      soft, abi: pad.abi, curve: c };
  }
  const fields = await probe(client, market.probe, ZERO, 'assetProbe', [], ['MARKET', 'QUOTE', 'DECIMALS']);
  if (!equal(fields.MARKET, market.market)) throw fail('BINDING_MISMATCH', 'Flap assetProbe 返回不同 Market');
  const [phase, token] = await Promise.all([
    read(client, market.market, FLAP.market, 'phase'), read(client, market.market, FLAP.market, 'token'),
  ]);
  const result = { ...market, quote: equal(fields.QUOTE, ZERO) ? NATIVE : fields.QUOTE, quoteDecimals: Number(fields.DECIMALS), phase: Number(phase) === 1 ? 'curve' : Number(phase) === 3 ? 'launched' : 'unavailable', token: equal(token, ZERO) ? null : token };
  if (result.phase === 'launched') {
    if (!result.token || (await client.getCode({ address: token })) === '0x') throw fail('INVALID_LAUNCH_TOKEN', 'Flap 实际 token 尚未部署');
    const s = await read(client, FLAP_MAIN, FLAP_ORDINARY, 'getTokenV8Safe', [token]);
    result.flapState = s;
    result.phase = Number(s.status) === 4 ? 'dex' : Number(s.status) === 1 ? 'flap-curve' : 'unavailable';
  }
  return result;
}

const VT = 1066666666666666666666666667n;
const ceil = (n, d) => { if (d <= 0n) throw fail('INVALID_CURVE', '曲线分母不正确'); return (n + d - 1n) / d; };
export function gangBuy(curve, gross, room) {
  const [, , raised, sold, grad, virtual] = curve.map((x, i) => [2,3,4,5].includes(i) ? BigInt(x) : x);
  const k = virtual * VT, q = virtual + raised, t = VT - sold;
  if (grad <= raised || room <= 0n) throw fail('CURVE_CLOSED_OR_CAP', '曲线已满或达到钱包持仓上限');
  let net = gross - gross / 100n, fee = gross / 100n, refund = 0n;
  function recompute(target) {
    const spent = ceil(target * 10000n, 9900n) < gross ? ceil(target * 10000n, 9900n) : gross;
    fee = spent / 100n; net = spent - fee; refund = gross - spent;
  }
  const remaining = grad - raised;
  if (net > remaining) { recompute(remaining); if (net > remaining) net = remaining; }
  let tokens = t - ceil(k, q + net);
  if (tokens > room) { tokens = room; recompute(ceil(k, t - room) - q); }
  if (tokens <= 0n) throw fail('ZERO_OUTPUT', '买入报价为零');
  return { amount: tokens, fee, refund };
}
export function gangSell(curve, amount) {
  const raised = BigInt(curve[2]), sold = BigInt(curve[3]), virtual = BigInt(curve[5]);
  if (amount > sold) throw fail('INVALID_CURVE_AMOUNT', '卖出数量超过曲线售出数量');
  const gross = virtual + raised - ceil(virtual * VT, VT - sold + amount);
  return gross - gross / 100n;
}
export async function buildFlap(client, s, wallet, side, quantity, slip) {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const call = (name, args, required) => probe(client, s.probe, wallet, name, args, required, blockNumber);
  const asset = await call('assetProbe', [], ['MARKET', 'QUOTE', 'DECIMALS']);
  if (!equal(asset.MARKET, s.market) || !equal(asset.QUOTE, equal(s.quote, NATIVE) ? ZERO : s.quote) || Number(asset.DECIMALS) !== s.quoteDecimals) throw fail('BINDING_MISMATCH', 'Flap 报价资产或精度变化');
  if (side === 'buy') {
    const [status, capacity] = await Promise.all([
      call('actionStatusProbe', [], ['BUY_OK', 'PHASE']), call('buyCapacityProbe', [], ['ID', 'PHASE', 'ROOM_SHARES']),
    ]);
    if (status.PHASE !== '1' || capacity.PHASE !== '1' || status.BUY_OK !== '1' || capacity.ID !== '1') throw fail('BUY_NOT_ALLOWED', 'Flap 买入资格或阶段不满足', { status, capacity });
    const native = equal(s.quote, NATIVE);
    const plan = await call('buyPlanProbe', [quantity, BigInt(slip)], ['MIN_SHARES', 'BUY_SHARES', 'RULES_OK', 'BLOCK']);
    if (plan.RULES_OK !== '1' || BigInt(plan.BLOCK) !== blockNumber) throw fail('BUY_NOT_ALLOWED', 'Flap 买入计划未通过', { plan });
    return { tx: tx(FLAP_PORTAL, FLAP.portal, native ? 'buy' : 'buyWithQuote', native ? [s.market, BigInt(plan.MIN_SHARES)] : [s.market, quantity, BigInt(plan.MIN_SHARES)], native ? quantity : 0n),
      approval: native ? null : { token: s.quote, spender: s.market, amount: quantity }, estimate: { sharesRaw: plan.BUY_SHARES, minSharesRaw: plan.MIN_SHARES }, positionKind: 'shares' };
  }
  const position = await call('positionProbe', [], ['HELD_SHARES', 'SELL_OK', 'PHASE']);
  if (position.PHASE !== '1' || position.SELL_OK !== '1' || BigInt(position.HELD_SHARES) === 0n) throw fail('SELL_NOT_ALLOWED', 'Flap 没有可卖内盘份额', { position });
  const ratio = shareBps(quantity);
  const native = equal(s.quote, NATIVE);
  const key = native ? 'MIN_WEI' : 'MIN_RAW';
  const plan = await call('sellPlanCustomProbe', [ratio, BigInt(slip)], ['SHARES', key, 'BLOCK']);
  if (BigInt(plan.BLOCK) !== blockNumber) throw fail('STALE_PLAN', 'Flap 报价区块不一致');
  return { tx: tx(FLAP_PORTAL, FLAP.portal, 'sellBps', [s.market, ratio, BigInt(plan[key])]), approval: null,
    estimate: { sharesRaw: plan.SHARES, minQuoteRaw: plan[key] }, positionKind: 'shares' };
}
export async function buildGang(client, s, wallet, side, quantity, slip) {
  if (side === 'buy') {
    if (!await read(client, s.market, s.abi, 'isAgent', [wallet])) throw fail('NO_AGENT_ID', 'Gang 买入需要 Agent ID');
    let expected;
    if (s.soft) { const q = await read(client, s.market, s.abi, 'quoteBuy', [s.token, wallet, quantity]); expected = { amount: q[0], fee: q[2], refund: q[3] }; }
    else { const room = await read(client, s.market, s.abi, 'walletRoom', [s.token, wallet]); expected = gangBuy(s.curve, quantity, room); }
    if (expected.amount <= 0n) throw fail('ZERO_OUTPUT', 'Gang 报价为零');
    return { tx: tx(s.market, s.abi, 'buy', s.soft ? [s.token, down(expected.amount, slip)] : [s.token, quantity, down(expected.amount, slip)], s.soft ? quantity : 0n),
      approval: s.soft ? null : { token: s.quote, spender: s.market, amount: quantity }, estimate: expected };
  }
  if (!s.soft && !await read(client, s.market, s.abi, 'isAgent', [wallet])) throw fail('NO_AGENT_ID', '当前 Gang 版本卖出需要 Agent ID');
  const expected = s.soft ? (await read(client, s.market, s.abi, 'quoteSell', [s.token, quantity]))[0] : gangSell(s.curve, quantity);
  if (expected <= 0n) throw fail('ZERO_OUTPUT', 'Gang 卖出报价为零');
  return { tx: tx(s.market, s.abi, 'sell', [s.token, quantity, down(expected, slip)]),
    approval: { token: s.token, spender: s.market, amount: quantity }, estimate: { quoteOutRaw: expected, minQuoteRaw: down(expected, slip) } };
}
export async function buildOrdinaryFlap(client, s, wallet, side, quantity, slip) {
  const inputToken = side === 'buy' ? (s.flapState.nativeToQuoteSwapEnabled || equal(s.flapState.quoteTokenAddress, ZERO) ? ZERO : s.flapState.quoteTokenAddress) : s.token;
  const outputToken = side === 'buy' ? s.token : (equal(s.flapState.quoteTokenAddress, ZERO) ? ZERO : s.flapState.quoteTokenAddress);
  const raw = await client.call({ account: wallet, to: FLAP_MAIN, data: encodeFunctionData({ abi: FLAP_ORDINARY, functionName: 'quoteExactInput', args: [{ inputToken, outputToken, inputAmount: quantity }] }) });
  const [expected] = decodeAbiParameters(parseAbiParameters('uint256'), raw.data);
  if (expected <= 0n) throw fail('ZERO_OUTPUT', 'Flap 报价为零');
  const params = { inputToken, outputToken, inputAmount: quantity, minOutputAmount: down(expected, slip), permitData: '0x' };
  return { tx: tx(FLAP_MAIN, FLAP_ORDINARY, 'swapExactInput', [params], equal(inputToken, ZERO) ? quantity : 0n),
    approval: equal(inputToken, ZERO) ? null : { token: inputToken, spender: FLAP_MAIN, amount: quantity },
    outputToken: equal(outputToken, ZERO) ? NATIVE : outputToken, estimate: { outRaw: expected, minOutRaw: params.minOutputAmount } };
}
