import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, formatUnits, getAddress, decodeEventLog, parseAbi } from 'viem';
import { bsc } from 'viem/chains';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ZERO = '0x0000000000000000000000000000000000000000';
export const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
export const json = (o) => JSON.stringify(o, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export const emit = (o) => process.stdout.write(json(o) + '\n');
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const exec = promisify(execFile);
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
export const stateDir = () => resolve(process.env.AGENT_TRADE_HOME || join(homedir(), '.agent-trade'));
export function loadConfig() {
  const defaults = JSON.parse(readFileSync(join(ROOT, 'defaults.json'), 'utf8'));
  let user = {};
  try { user = JSON.parse(readFileSync(join(stateDir(), 'config.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw fail('INVALID_CONFIG', e.message); }
  const cfg = { ...defaults, ...user };
  if (process.env.AGENT_TRADE_RPC_URL) cfg.rpcUrl = process.env.AGENT_TRADE_RPC_URL;
  if (process.env.AGENT_TRADE_BAW_BIN) cfg.bawBin = process.env.AGENT_TRADE_BAW_BIN;
  validateConfig(cfg);
  return cfg;
}
export function validateConfig(cfg) {
  units(cfg.buyAmountBnb); bps(cfg.slippageBps); bps(cfg.swapSlippageBps);
  if (!/^https?:\/\//.test(cfg.rpcUrl)) throw fail('INVALID_CONFIG', 'RPC URL 需要 http(s)');
  if (!Number.isInteger(cfg.waitSeconds) || cfg.waitSeconds < 1 || cfg.waitSeconds > 300) throw fail('INVALID_CONFIG', 'waitSeconds 应为 1–300');
  if (typeof cfg.bawBin !== 'string' || !cfg.bawBin) throw fail('INVALID_CONFIG', 'bawBin 不能为空');
}
export function atomicWrite(path, data) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, json(data)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export const clientFor = (rpcUrl) => createPublicClient({ chain: bsc, transport: http(rpcUrl, { retryCount: 0, timeout: 10000, batch: { wait: 5 } }) });
export async function checkedClient(cfg) {
  const client = clientFor(cfg.rpcUrl);
  if (await client.getChainId() !== 56) throw fail('WRONG_CHAIN', 'RPC 必须连接 BSC 主网（56）');
  return client;
}
export async function childJson(file, args, timeout = 60000) {
  let output;
  try { output = await exec(file, args.map(String), { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }); }
  catch (e) {
    if (e.code === 'ENOENT') throw fail('MISSING_COMMAND', `找不到 ${file}；请安装或配置该命令`);
    if (e.killed || e.signal) throw fail('COMMAND_TIMEOUT', `${file} 执行超时，不能假定未提交`);
    output = e;
  }
  let result;
  try { result = JSON.parse(output.stdout?.trim()); }
  catch { throw fail('INVALID_CLI_RESPONSE', `${file} 未返回 JSON`, { stderr: String(output.stderr || '').slice(-2000) }); }
  if (!result.success) throw fail(result.error?.name || result.error?.code || 'CLI_ERROR', result.error?.message || json(result.error), { raw: result.error });
  return result.data;
}
export class Baw {
  constructor(cfg) { this.cfg = cfg; }
  call(args, timeout) { return childJson(this.cfg.bawBin, [...args, '--json'], timeout); }
  async session({ connect = true } = {}) {
    const state = await this.call(['wallet', 'status']);
    if (state.status !== 'CONNECTED') {
      if (!connect) throw fail('NEEDS_LOGIN', '当前环境的 baw 未连接；运行 agent connect');
      await this.connect();
    }
    const [addresses, settings] = await Promise.all([this.call(['wallet', 'address']), this.call(['wallet', 'settings'])]);
    const list = Array.isArray(addresses) ? addresses : addresses.addresses;
    if (!Array.isArray(list)) throw fail('UNKNOWN_WALLET_RESPONSE', '无法解析 baw wallet address');
    const item = list.find(x => String(x.binanceChainId) === '56');
    if (!item?.address) throw fail('NO_BSC_WALLET', '未找到 BSC 钱包地址');
    return { wallet: address(item.address), settings };
  }
  async connect() {
    const info = await this.call(['auth', 'signin']);
    if (info.status !== 'ALREADY_CONNECTED') {
      if (!info.pairingCode || !info.urlForWeb || !info.qrCodeId) throw fail('INVALID_AUTH_RESPONSE', '登录返回缺少配对信息');
      emit({ event: 'AUTH_PAIRING', pairingCode: info.pairingCode, urlForWeb: info.urlForWeb, message: '在 Binance App 确认配对；保留当前进程运行' });
      await this.call(['auth', 'verify', '--qrCodeId', info.qrCodeId], 310000);
    }
    const result = await this.call(['wallet', 'status']);
    if (result.status !== 'CONNECTED') throw fail('NEEDS_LOGIN', '配对后仍未 CONNECTED，请重新连接');
    return result;
  }
}
export function developerMode(settings) {
  if (!settings.devMode?.enabled || (settings.devMode.expiresAt && Number(settings.devMode.expiresAt) * 1000 <= Date.now())) {
    throw fail('DEVELOPER_MODE_REQUIRED', '请在 Binance App → Agentic Wallet 设置开启 Developer Mode');
  }
}
export class Journal {
  constructor(data) { this.data = data; this.path = join(stateDir(), 'operations', data.id + '.json'); }
  static create(intent, wallet, cfg) { const j = new Journal({ id: randomUUID(), wallet, intent, cfg, status: 'RUNNING', createdAt: new Date().toISOString(), steps: {}, values: {} }); j.save(); return j; }
  static load(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw fail('INVALID_OPERATION_ID', '无效 operationId');
    return new Journal(JSON.parse(readFileSync(join(stateDir(), 'operations', id + '.json'), 'utf8')));
  }
  save() { this.data.updatedAt = new Date().toISOString(); atomicWrite(this.path, this.data); }
  value(key, value) { if (value !== undefined) { this.data.values[key] = value; this.save(); } return this.data.values[key]; }
}
export function walletLock(wallet, currentId) {
  const dir = stateDir(); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'wallet-' + wallet.toLowerCase() + '.lock');
  try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let alive = true;
    try { process.kill(Number(readFileSync(path, 'utf8')), 0); } catch (x) { if (x.code === 'ESRCH') alive = false; }
    if (alive) throw fail('WALLET_BUSY', '同一钱包已有命令运行，不重复下单');
    unlinkSync(path); return walletLock(wallet, currentId);
  }
  const unlock = () => { try { unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  try {
    const ops = join(dir, 'operations');
    let names = []; try { names = readdirSync(ops); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of names.filter(x => x.endsWith('.json'))) {
      const op = JSON.parse(readFileSync(join(ops, name), 'utf8'));
      if (op.id !== currentId && equal(op.wallet, wallet) && !['SUCCESS', 'FAILED', 'BLOCKED'].includes(op.status)) {
        throw fail('UNFINISHED_OPERATION', '先查询或继续已有操作，避免重复下单', { operationId: op.id, status: op.status });
      }
    }
  } catch (e) { unlock(); throw e; }
  return unlock;
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
