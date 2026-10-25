import { secp256k1 } from '@noble/curves/secp256k1';
import { getAddress } from 'viem';
import { store, patchAuth } from './storage.mjs';
import { historyTransactionHash } from './history.mjs';

const BASE = 'https://www.binance.com';
const AGENT = '/bapi/defi/v1/public/wallet-direct/agent-wallet/';
const DEX = '/bapi/defi/v1/public/wallet-direct/web-dex/agent/';
const HISTORY = '/bapi/defi/v2/public/wallet-direct/agent/';
const fail = (code, message, data = {}) => Object.assign(new Error(message), { code, data });
const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
export function pairingKey() {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const key = hex(secp256k1.getPublicKey(privateKey, true)).slice(2);
  privateKey.fill(0); // Only a pairing identifier; never a wallet private key.
  return { publicKeyHex: key, pairingCode: key.slice(0, 3) + key.slice(-3) };
}
export function cookieRule(extensionId, sessionId) {
  return { id: 1, priority: 1, action: { type: 'modifyHeaders', requestHeaders: [sessionId
    ? { header: 'Cookie', operation: 'set', value: 'agentSessionId=' + sessionId }
    : { header: 'Cookie', operation: 'remove' }] }, condition: {
      urlFilter: '|https://www.binance.com/bapi/defi/', initiatorDomains: [extensionId], resourceTypes: ['xmlhttprequest'],
    } };
}
export class Transport {
  constructor({ api = globalThis.chrome, fetcher = (...args) => globalThis.fetch(...args), now = () => performance.now() } = {}) {
    Object.assign(this, { api, fetcher, now }); this.cookieWrites = Promise.resolve(); this.ruleWrites = Promise.resolve(); this.metrics = [];
  }
  listenForCookies() {
    const ownOrigin = this.api.runtime.getURL('').replace(/\/$/, '');
    this.api.webRequest.onHeadersReceived.addListener(details => {
      if (details.initiator !== ownOrigin || !details.url.startsWith(BASE + '/bapi/defi/')) return;
      for (const h of details.responseHeaders || []) {
        const match = h.name.toLowerCase() === 'set-cookie' && h.value?.match(/^agentSessionId=([^;]*)/i);
        if (match) this.cookieWrites = this.cookieWrites.then(() => patchAuth({ sessionId: match[1] || null }));
      }
    }, { urls: [BASE + '/bapi/defi/*'] }, ['responseHeaders', 'extraHeaders']);
  }
  async prepare() {
    this.identityReady ||= (async () => {
      if (!(await store.get('auth', {})).clientId) {
        const platform = await this.api.runtime.getPlatformInfo();
        const os = { mac: 'macOS', win: 'Windows', linux: 'Linux', cros: 'ChromeOS', android: 'Android' }[platform.os] || 'Chrome';
        await patchAuth({ clientId: crypto.randomUUID(), deviceId: '02:' + hex(crypto.getRandomValues(new Uint8Array(5))).match(/../g).join(':'), os });
      }
    })();
    await this.identityReady;
    const auth = await store.get('auth', {});
    const update = this.ruleWrites.then(() => this.api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1], addRules: [cookieRule(this.api.runtime.id, auth.sessionId)] }));
    this.ruleWrites = update.catch(() => {}); await update;
    return auth;
  }
  async request(path, method = 'GET', body) {
    if (!path.startsWith(AGENT) && !path.startsWith(DEX) && !path.startsWith(HISTORY)) throw fail('INVALID_API_PATH', '接口不在允许范围');
    const auth = await this.prepare(), started = this.now();
    try {
      const response = await this.fetcher(BASE + path, { method, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', agentClientId: auth.clientId, 'bnc-uuid': auth.clientId,
          agentClientSystem: 'Chrome Extension / ' + (auth.os || 'Chrome'), agentClientMac: auth.deviceId, device_name: 'Agent Trade Chrome',
          'x-trace-id': hex(crypto.getRandomValues(new Uint8Array(16))), system_lang: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, system_version: navigator.platform || 'Chrome',
          version_code: '1.12.0', clientVersion: '1.12.0', agentClientType: 'AGENT_CLI', agentClientVersion: '1.12.0' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      // fetch cannot read Set-Cookie. The extension-only webRequest observer can.
      await this.cookieWrites;
      if (!response.ok) throw fail('HTTP_' + response.status, 'Binance HTTP ' + response.status);
      let data; try { data = await response.json(); } catch { throw fail('INVALID_API_RESPONSE', 'Binance 未返回 JSON'); }
      if (data.code !== '000000') {
        if (data.code === '100001005') await patchAuth({ sessionId: null, connected: false });
        throw fail(String(data.code || 'API_ERROR'), data.message || 'Binance 接口错误', { raw: { code: data.code } });
      }
      return data.data;
    } finally { this.metrics.push({ path: path.split('?')[0], ms: Math.round(this.now() - started) }); }
  }
}
export const transport = new Transport();
export function walletAddresses(data) {
  if (!Array.isArray(data)) throw fail('INVALID_WALLET_RESPONSE', '钱包列表格式变化');
  return data.flatMap(wallet => wallet.subWalletList || []).flatMap(sub => sub.addresses || [])
    .filter(item => String(item.binanceChainId) === '56').map(item => ({ ...item, address: getAddress(item.address) }));
}
export function mapMarketOrders(data) {
  if (!Array.isArray(data.rows)) throw fail('INVALID_ORDER_RESPONSE', '订单列表格式变化');
  return { list: data.rows.map(row => ({ ...row, orderId: row.orderId || row.id, fromToken: row.fromTokenAddress,
    toToken: row.toTokenAddress, txHash: row.orderTxId, toTokenActualQty: row.toTokenActualQty })) };
}
export class Baw {
  constructor(cfg = {}, api = transport) { this.cfg = cfg; this.api = api; }
  async session() {
    const query = await this.api.request(AGENT + 'login/query');
    if (query.connectionStatus !== 'CONNECTED' || query.walletCreateStatus !== 'CREATED') throw fail('NEEDS_LOGIN', '请先打开扩展连接钱包');
    const [wallets, settings] = await Promise.all([this.api.request(AGENT + 'mpc-wallet/list', 'POST'), this.api.request(AGENT + 'settings/query')]);
    const list = walletAddresses(wallets), unique = [...new Set(list.map(item => item.address.toLowerCase()))];
    if (unique.length !== 1) throw fail('AMBIGUOUS_WALLET', '未找到唯一 BSC 钱包，停止交易');
    return { wallet: list[0].address, settings };
  }
  async call(args) {
    const [group, command] = args;
    const opt = name => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
    if (group === 'contract-call' && command === 'preview') return this.api.request(AGENT + 'contract-call/preview', 'POST', {
      binanceChainId: '56', from: opt('from'), to: opt('to'), value: opt('value'), inputData: opt('inputData'),
    });
    if (group === 'contract-call' && command === 'execute') return this.api.request(AGENT + 'contract-call/execute', 'POST', { requestId: opt('requestId') });
    if (group === 'wallet' && command === 'tx-history') {
      const target = opt('orderId'), now = Date.now(), requestedStart = Number(opt('startTime'));
      const startTime = Number.isFinite(requestedStart) && requestedStart >= 0 ? requestedStart : now - 90 * 24 * 60 * 60 * 1000;
      const readPages = async endpoint => {
        const pages = [], seen = new Set(); let cursor;
        for (let page = 0; page < (target ? 10 : 1); page++) {
          // The HTTP API uses plural binanceChainIds; the CLI flag is singular.
          const params = new URLSearchParams({ binanceChainIds: '56', size: '100', startTime: String(startTime), endTime: String(now), hideRisk: 'false', hideLowValue: 'false' });
          if (cursor) params.set('nextToken', cursor);
          const data = await this.api.request(HISTORY + endpoint + '?' + params);
          pages.push(data);
          if (target && historyTransactionHash(pages, target)) break;
          if (!data.nextToken || seen.has(String(data.nextToken))) break;
          cursor = String(data.nextToken); seen.add(cursor);
        }
        return pages;
      };
      const responses = await Promise.allSettled([readPages('tx-history-pending'), readPages('tx-history-confirm')]);
      const history = { pending: responses[0].status === 'fulfilled' ? responses[0].value : [], confirmed: responses[1].status === 'fulfilled' ? responses[1].value : [] };
      // A temporary failure in one list must not hide exact evidence in the other.
      if (target && historyTransactionHash(history, target)) return history;
      const failure = responses.find(response => response.status === 'rejected');
      if (failure) throw failure.reason;
      return history;
    }
    if (group === 'market-order' && command === 'list') return mapMarketOrders(await this.api.request(DEX + 'batch-query-market-orders', 'POST', { orderId: opt('orderId'), page: 1, pageSize: 1 }));
    if (group === 'market-order' && ['quote', 'swap'].includes(command)) {
      const result = await this.api.request(DEX + (command === 'quote' ? 'quote' : 'place-order'), 'POST', {
        binanceChainId: '56', fromToken: opt('fromToken'), toToken: opt('toToken'), amount: opt('fromTokenQty'),
        slippage: String(Number(opt('slippage')) / 100), ...(command === 'swap' ? { mev: true, gasLevel: 'MEDIUM' } : {}),
      });
      if (result.code && result.code !== '000000') throw fail(result.code, result.message || '换币订单失败');
      return result;
    }
    throw fail('UNSUPPORTED_COMMAND', '扩展不支持该钱包指令');
  }
}
export async function startLogin() {
  if ((await store.get('auth', {})).sessionId) {
    try { const query = await transport.request(AGENT + 'login/query'); if (query.connectionStatus === 'CONNECTED' && query.walletCreateStatus === 'CREATED') return initializeSession(); }
    catch (e) { if (!['100001005', '10003002', '10003003'].includes(e.code)) throw e; }
  }
  const key = pairingKey();
  const device = await transport.prepare();
  const result = await transport.request(AGENT + 'login', 'POST', { isFirstLogin: true, os: device.os || 'Chrome', publicKeyHex: key.publicKeyHex });
  if (!result.qrInfo?.qrCodeId || !result.qrInfo.qrCodeUrl) throw fail('INVALID_AUTH_RESPONSE', '登录未返回配对信息');
  const url = new URL(result.qrInfo.qrCodeUrl);
  if (url.protocol !== 'https:' || !(url.hostname === 'binance.com' || url.hostname.endsWith('.binance.com'))) throw fail('INVALID_AUTH_URL', '配对链接不属于 Binance');
  const login = { qrCodeId: result.qrInfo.qrCodeId, url: url.href, expireAt: Number(result.qrInfo.expireAt), pairingCode: key.pairingCode, phase: 'CONFIRM' };
  await store.set('login', login); return { status: 'AUTH_PAIRING', ...login };
}
export async function pollLogin() {
  const login = await store.get('login');
  if (!login) return { status: 'NO_PAIRING' };
  if (!Number.isFinite(login.expireAt) || login.expireAt <= Date.now()) { await store.remove('login'); throw fail('AUTH_EXPIRED', '配对已过期，请重新连接'); }
  if (login.phase === 'CONFIRM') {
    const result = await transport.request(AGENT + 'login/confirm', 'POST', { qrCodeId: login.qrCodeId });
    if (result.connectionStatus !== 'CONNECTED') return { status: 'AUTH_PAIRING', ...login };
    login.phase = 'QUERY'; await store.set('login', login);
  }
  const result = await transport.request(AGENT + 'login/query');
  if (result.connectionStatus !== 'CONNECTED' || result.walletCreateStatus !== 'CREATED') return { status: 'AUTH_PAIRING', ...login };
  const initialized = await initializeSession(); await store.remove('login'); return initialized;
}
export async function initializeSession() {
  const session = await new Baw().session();
  const settings = { devMode: session.settings.devMode, tradeAllTokens: session.settings.tradeAllTokens, dailyLimit: session.settings.dailyLimit };
  await patchAuth({ connected: true }); await store.set('wallet', session.wallet); await store.set('walletSettings', settings);
  return { status: 'CONNECTED', wallet: session.wallet, ...settings };
}
export async function signOut() {
  try { await transport.request(AGENT + 'login/logout', 'POST'); }
  finally { await patchAuth({ sessionId: null, connected: false }); await store.remove('wallet'); await store.remove('walletSettings'); await store.remove('login'); await transport.prepare(); }
  return { status: 'SIGNED_OUT' };
}
