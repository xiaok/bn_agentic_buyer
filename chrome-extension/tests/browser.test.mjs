import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedSite, tokenFromUrl, validateMessage } from '../src/routes.mjs';
import { Transport, Baw, pairingKey, cookieRule, walletAddresses, mapMarketOrders } from '../src/baw.mjs';
import { Executor } from '../src/engine/executor.mjs';
import { Journal, store } from '../src/storage.mjs';
import { flapMarketFromDocument, tokenFromPage } from '../src/page-address.mjs';

const token = '0x1111111111111111111111111111111111111111';
const other = '0x2222222222222222222222222222222222222222';
test('URL extraction is exact, excludes numeric presets, ambiguous tokens and untrusted sites', () => {
  assert.equal(tokenFromUrl('https://four.meme/zh-TW/token/' + token), token);
  assert.equal(tokenFromUrl('https://flap.sh/apps/agent-bonding-curve?market=' + token), token);
  assert.equal(tokenFromUrl('https://gang.fun/token/' + token), token);
  assert.equal(tokenFromUrl('https://four.meme/zh-TW/contract/1778027615735'), null);
  assert.equal(tokenFromUrl('https://flap.sh/?token=' + token + '&market=' + other), null);
  assert.equal(tokenFromUrl('https://evil.four.meme/?token=' + token), null);
  assert(!allowedSite('http://four.meme/'));
});
test('webpage callers cannot read auth, connect, change config or send arbitrary API requests', () => {
  const sender = { id: 'extension', frameId: 0, url: 'https://four.meme/token/' + token };
  assert.equal(validateMessage({ type: 'BUY' }, sender, 'extension').own, false);
  for (const type of ['CONNECT', 'CONFIG', 'SIGN_OUT', 'REQUEST', 'SESSION', 'SELL']) assert.throws(() => validateMessage({ type }, sender, 'extension'));
  assert.throws(() => validateMessage({ type: 'BUY' }, { ...sender, frameId: 1 }, 'extension'));
  assert.throws(() => validateMessage({ type: 'BUY' }, { ...sender, id: 'other' }, 'extension'));
  assert(validateMessage({ type: 'CONFIG' }, { id: 'extension', url: 'chrome-extension://extension/dashboard.html' }, 'extension').own);
});
test('Flap details bind only the visible Market-address block, never a predicted token or wallet', () => {
  const label = { children: [], textContent: 'Market 地址', getClientRects: () => [1], parentElement: { innerText: 'Market 地址\n' + token, parentElement: null } };
  const predicted = { children: [], textContent: '预测代币地址', getClientRects: () => [1], parentElement: { innerText: other } };
  const doc = { querySelectorAll: () => [label, predicted] };
  assert.equal(flapMarketFromDocument(doc), token);
  assert.equal(tokenFromPage(doc, 'https://flap.sh/apps/agent-bonding-curve?lang=zh'), token);
  assert.equal(tokenFromPage(doc, 'http://flap.sh/apps/agent-bonding-curve'), null);
  label.parentElement.innerText += '\n' + other;
  assert.equal(flapMarketFromDocument(doc), null);
  label.parentElement.innerText = token; label.getClientRects = () => [];
  assert.equal(flapMarketFromDocument(doc), null);
});
test('session cookie rule applies only to this extension and Binance API requests', () => {
  const rule = cookieRule('abc', 'secret');
  assert.deepEqual(rule.condition.initiatorDomains, ['abc']);
  assert.equal(rule.condition.urlFilter, '|https://www.binance.com/bapi/defi/');
  assert.equal(rule.action.requestHeaders[0].value, 'agentSessionId=secret');
  assert.equal(cookieRule('abc', null).action.requestHeaders[0].operation, 'remove');
});
test('pairing key produces the official six-character fingerprint without a wallet key', () => {
  const key = pairingKey();
  assert.match(key.publicKeyHex, /^[0-9a-f]{64}$/);
  assert.equal(key.pairingCode, key.publicKeyHex.slice(0, 3) + key.publicKeyHex.slice(-3));
  assert.deepEqual(Object.keys(key).sort(), ['pairingCode', 'publicKeyHex']);
});
test('API adapter converts percent slippage and raw order fields exactly once', async () => {
  const calls = [], api = { async request(...args) { calls.push(args); return args[0].includes('batch-query') ? { rows: [{ id: 'own', fromTokenAddress: token, toTokenAddress: other, orderTxId: '0xhash', status: 'FINISHED' }] } : { orderId: 'own' }; } };
  const baw = new Baw({}, api);
  await baw.call(['market-order', 'swap', '--fromToken', token, '--toToken', other, '--fromTokenQty', '0.001', '--slippage', '1']);
  assert.equal(calls[0][2].slippage, '0.01'); assert.equal(calls[0][2].amount, '0.001'); assert.equal(calls[0][2].mev, true);
  const result = await baw.call(['market-order', 'list', '--orderId', 'own']);
  assert.equal(result.list[0].fromToken, token); assert.equal(result.list[0].txHash, '0xhash');
  assert.throws(() => mapMarketOrders({ list: [] }));
  assert.equal(walletAddresses([{ subWalletList: [{ addresses: [{ binanceChainId: '56', address: token }, { binanceChainId: '1', address: other }] }] }])[0].address, token);
});
test('connected browser client checks current session and returns the unique BSC wallet', async () => {
  const api = { async request(path) {
    if (path.endsWith('login/query')) return { connectionStatus: 'CONNECTED', walletCreateStatus: 'CREATED' };
    if (path.endsWith('mpc-wallet/list')) return [{ subWalletList: [{ addresses: [{ binanceChainId: '56', address: token }] }] }];
    return { devMode: { enabled: true, expiresAt: 2000000000 } };
  } };
  assert.equal((await new Baw({}, api).session()).wallet, token);
  await assert.rejects(new Baw({}, { async request() { return { connectionStatus: 'UNCONNECTED' }; } }).session(), { code: 'NEEDS_LOGIN' });
});
function memoryChrome() {
  const records = {};
  const chrome = { storage: { local: {
    async get(key) { if (key === null) return structuredClone(records); return { [key]: structuredClone(records[key]) }; },
    async set(value) { Object.assign(records, structuredClone(value)); }, async remove(key) { delete records[key]; },
  } }, runtime: { id: 'abc', getURL: value => 'chrome-extension://abc/' + value, async getPlatformInfo() { return { os: 'mac' }; } },
  declarativeNetRequest: { async updateSessionRules() {} } };
  return { chrome, records };
}
test('parallel transport calls reuse one client ID, isolate cookies and do not retry execute failures', async () => {
  const { chrome } = memoryChrome(); globalThis.chrome = chrome;
  const requests = [], api = new Transport({ api: chrome, fetcher: async (url, options) => {
    requests.push({ url, options }); return { ok: true, async json() { return { code: '000000', data: { requestId: 'own' } }; } };
  } });
  await Promise.all([api.request('/bapi/defi/v1/public/wallet-direct/agent-wallet/login/query'), api.request('/bapi/defi/v1/public/wallet-direct/agent-wallet/settings/query')]);
  assert.equal(requests[0].options.headers.agentClientId, requests[1].options.headers.agentClientId);
  assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.headers.Cookie, undefined);
  let attempts = 0; api.fetcher = async () => { attempts++; throw new Error('network disconnected'); };
  await assert.rejects(api.request('/bapi/defi/v1/public/wallet-direct/agent-wallet/contract-call/execute', 'POST', { requestId: 'own' }));
  assert.equal(attempts, 1);
  await assert.rejects(api.request('/outside/allowed-api'));
});
test('browser journal persistence is awaited before execute; a storage failure cannot submit', async () => {
  let writes = 0, executes = 0;
  const journal = { data: { id: 'x', steps: {} }, async save() { await new Promise(r => setTimeout(r, 1)); writes++; if (writes === 2) throw new Error('disk full'); } };
  const baw = { async call(args) { if (args[1] === 'execute') executes++; return { requestId: 'r', requireConfirmation: false }; } };
  const executor = new Executor({}, {}, token, { devMode: { enabled: true } }, journal, baw);
  await assert.rejects(executor.contract('trade', { to: other, value: '1', data: '0x1234' }), /disk full/);
  assert.equal(executes, 0); assert.equal(writes, 2);
});
test('a browser operation is durable, reloadable and cannot be created twice', async () => {
  globalThis.chrome = memoryChrome().chrome;
  const id = crypto.randomUUID(), journal = await Journal.create({ side: 'buy', token, amount: '0.001' }, token, {}, id);
  journal.data.steps.trade = { executeAttempted: true, status: 'SUBMITTING' }; await journal.save();
  assert.equal((await Journal.load(id)).data.steps.trade.status, 'SUBMITTING');
  await assert.rejects(Journal.create(journal.data.intent, token, {}, id));
  assert.equal((await store.get('operation:' + id)).intent.amount, '0.001');
});
