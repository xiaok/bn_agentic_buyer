import { createPublicClient, http, formatUnits, getAddress, decodeEventLog, parseAbi } from 'viem';
import { bsc } from 'viem/chains';
export { Baw } from '../baw.mjs';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const json = (o) => JSON.stringify(o, (_, v) => typeof v === 'bigint' ? v.toString() : v);
let eventSink = () => {};
export const setEventSink = sink => { eventSink = sink; };
export const emit = event => eventSink(JSON.parse(json(event)));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export function fail(code, message, data = {}) { return Object.assign(new Error(message), { code, data }); }
export function address(value) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? '')) throw fail('INVALID_ADDRESS', '需要完整 0x 地址');
  try { return getAddress(value); } catch { throw fail('INVALID_ADDRESS', '混合大小写地址校验失败；请核对地址'); }
}
export function units(value, decimals = 18) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw fail('INVALID_DECIMALS', '无法读取资产精度');
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) throw fail('INVALID_AMOUNT', '金额需要正十进制数字，不能使用科学计数法');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw fail('INVALID_AMOUNT', `金额超过 ${decimals} 位小数`);
  const raw = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (raw <= 0n) throw fail('INVALID_AMOUNT', '金额必须大于零');
  return raw;
}
export function bps(value) {
  const n = Number(value);
  if (!/^\d+$/.test(String(value)) || !Number.isInteger(n) || n < 0 || n >= 10000) throw fail('INVALID_SLIPPAGE', '滑点需要 0–9999 的整数 bps');
  return n;
}
export const down = (n, slip) => n * (10000n - BigInt(slip)) / 10000n;
export function sellQuantity(text, balance, decimals) {
  if (text === 'all') return balance;
  if (String(text).endsWith('%')) {
    const ratio = units(String(text).slice(0, -1), 2);
    if (ratio > 10000n) throw fail('INVALID_PERCENT', '比例不得超过 100%');
    const amount = balance * ratio / 10000n;
    if (amount === 0n) throw fail('NO_POSITION', '卖出数量为零');
    return amount;
  }
  const amount = units(text, decimals);
  if (amount > balance) throw fail('INSUFFICIENT_BALANCE', '卖出数量超过余额');
  return amount;
}
export function shareBps(text) {
  if (text === 'all') return 10000n;
  if (!String(text).endsWith('%')) throw fail('SHARE_PERCENT_REQUIRED', 'Flap 内盘请用 50% 或 all 指定卖出份额');
  const n = units(String(text).slice(0, -1), 2);
  if (n > 10000n) throw fail('INVALID_PERCENT', '比例不得超过 100%');
  return n;
}
export const clientFor = (rpcUrl) => createPublicClient({ chain: bsc, transport: http(rpcUrl, { retryCount: 0, timeout: 10000, batch: { wait: 5 } }) });
export async function checkedClient(cfg) {
  const client = clientFor(cfg.rpcUrl);
  if (await client.getChainId() !== 56) throw fail('WRONG_CHAIN', 'RPC 必须连接 BSC 主网（56）');
  return client;
}

export function developerMode(settings) {
  const expiry = settings.devMode?.expiresAt;
  const expiresMs = typeof expiry === 'number' ? expiry * 1000 : Date.parse(expiry);
  if (!settings.devMode?.enabled || (expiry && (!Number.isFinite(expiresMs) || expiresMs <= Date.now()))) throw fail('DEVELOPER_MODE_REQUIRED', '请在 Binance App 开启 Developer Mode');
}
const TRANSFER = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
export function erc20Delta(receipt, token, wallet) {
  let amount = 0n;
  for (const log of receipt.logs || []) {
    if (!equal(log.address, token)) continue;
    try {
      const event = decodeEventLog({ abi: TRANSFER, data: log.data, topics: log.topics });
      if (equal(event.args.to, wallet)) amount += event.args.value;
      if (equal(event.args.from, wallet)) amount -= event.args.value;
    } catch { /* non-Transfer event */ }
  }
  return amount;
}
export function tx(to, abi, functionName, args = [], value = 0n) { return { to, abi, functionName, args, value }; }
export { formatUnits };
