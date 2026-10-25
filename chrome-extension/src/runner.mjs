import { Baw, transport } from './baw.mjs';
import { getConfig, Journal, operations, store } from './storage.mjs';
import { checkedClient, address, units, bps, equal, fail, setEventSink } from './engine/core.mjs';
import { detect } from './engine/adapters.mjs';
import { runTrade } from './engine/trade.mjs';

let busy = false;
export function validateConfig(cfg) {
  units(cfg.buyAmountBnb); bps(cfg.slippageBps); bps(cfg.swapSlippageBps);
  if (!Number.isInteger(cfg.waitSeconds) || cfg.waitSeconds < 1 || cfg.waitSeconds > 300) throw fail('INVALID_CONFIG', '等待秒数应为 1–300');
  if (cfg.rpcUrl !== 'https://bsc-dataseed1.bnbchain.org') throw fail('INVALID_CONFIG', '此版本固定使用已声明权限的 BSC RPC');
}
function viewOperation(op) {
  return { id: op.id, status: op.status, createdAt: op.createdAt, intent: op.intent, wallet: op.wallet,
    result: op.result, error: op.lastError, progress: op.progress,
    steps: Object.values(op.steps).map(s => ({ name: s.name, status: s.status, txHash: s.txHash, orderId: s.orderId })), timings: op.timings };
}
export async function view() {
  const auth = await store.get('auth', {}), recent = await operations();
  return { status: 'VIEW', connected: !!auth.connected && !!auth.sessionId, wallet: await store.get('wallet'),
    login: await store.get('login'), walletSettings: await store.get('walletSettings'), config: await getConfig(), busy, operations: recent.slice(0, 12).map(viewOperation) };
}
async function checkPending(wallet, id) {
  const pending = (await operations()).find(op => op.id !== id && equal(op.wallet, wallet) && !['SUCCESS', 'FAILED', 'BLOCKED'].includes(op.status));
  if (pending) throw fail('UNFINISHED_OPERATION', '请先继续原订单，避免重复买入', { operationId: pending.id });
}
function recordError(journal, error) {
  const unresolved = Object.values(journal.data.steps).some(s => s.executeAttempted && !['CONFIRMED', 'FAILED'].includes(s.status));
  const pending = ['PENDING', 'PENDING_CONFIRMATION', 'SUBMISSION_UNKNOWN'].includes(error.code);
  journal.data.status = pending || unresolved ? (error.code === 'SUBMISSION_UNKNOWN' ? 'SUBMISSION_UNKNOWN' : 'PENDING') : 'FAILED';
  journal.data.lastError = { code: error.code || 'ERROR', message: error.shortMessage || error.message, data: error.data };
}
export async function startOrder(message) {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(message.id || '')) throw fail('INVALID_OPERATION_ID', '无效订单 ID');
  const token = address(message.token), side = message.type === 'SELL' ? 'sell' : 'buy';
  const amount = side === 'buy' ? String(message.amount) : String(message.amount);
  if (side === 'buy') units(amount);
  else if (amount !== 'all' && !/^(?:\d+(?:\.\d{1,2})?)%$/.test(amount)) throw fail('INVALID_SELL', '浏览器卖出使用 all 或百分比');
  else if (amount !== 'all' && units(amount.slice(0, -1), 2) > 10000n) throw fail('INVALID_SELL', '比例不能超过 100%');
  // A replay returns the original operation; it never starts a second order.
  const existing = await store.get('operation:' + message.id);
  if (existing) {
    if (existing.intent.side !== side || !equal(existing.intent.token, token) || existing.intent.amount !== amount) throw fail('ORDER_ID_CONFLICT', '同一订单 ID 的参数不一致');
    return viewOperation(existing);
  }
  if (busy) throw fail('WALLET_BUSY', '已有操作进行中');
  busy = true;
  try {
    const cfg = await getConfig(); validateConfig(cfg);
    const baw = new Baw(cfg), expectedWallet = await store.get('wallet');
    if (!expectedWallet) throw fail('NEEDS_LOGIN', '先打开扩展连接并核对钱包地址');
    const [client, session] = await Promise.all([checkedClient(cfg), baw.session()]);
    if (!equal(session.wallet, expectedWallet)) throw fail('WALLET_CHANGED', '返回钱包地址变化，请先在扩展中核对');
    await checkPending(session.wallet, message.id);
    const journal = await Journal.create({ side, token, amount }, session.wallet, cfg, message.id);
    launch(client, cfg, baw, session, journal, null); return viewOperation(journal.data);
  } catch (e) { busy = false; throw e; }
}
export async function resumeOrder(id) {
  const journal = await Journal.load(id);
  if (journal.data.status === 'SUCCESS') return viewOperation(journal.data);
  if (['FAILED', 'BLOCKED'].includes(journal.data.status)) throw fail('OPERATION_STOPPED', '已停止的订单不自动重试');
  if (busy) throw fail('WALLET_BUSY', '已有操作进行中');
  busy = true;
  try {
    const cfg = journal.data.cfg; validateConfig(cfg);
    const baw = new Baw(cfg), [client, session] = await Promise.all([checkedClient(cfg), baw.session()]);
    if (!equal(session.wallet, journal.data.wallet)) throw fail('WALLET_CHANGED', '当前钱包与原订单不一致');
    await checkPending(session.wallet, id);
    journal.data.status = 'RUNNING'; await journal.save();
    launch(client, cfg, baw, session, journal, journal.value('detectedMarket')); return viewOperation(journal.data);
  } catch (e) { busy = false; throw e; }
}
function launch(client, cfg, baw, session, journal, knownMarket) {
  const started = performance.now(), metricOffset = transport.metrics.length;
  // Chrome 120+: extension API activity keeps an active order alive. A crash or
  // browser close still requires explicit recovery; no startup hook re-executes.
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  setEventSink(event => { journal.data.progress = { ...event, elapsedMs: Math.round(performance.now() - started) }; });
  const execute = async () => {
    try {
      const market = knownMarket || await detect(client, cfg, journal.data.intent.token);
      await runTrade(client, cfg, market, session, journal, baw);
    } catch (e) { recordError(journal, e); }
    finally {
      journal.data.timings = { elapsedMs: Math.round(performance.now() - started), requests: transport.metrics.slice(metricOffset) };
      try { await journal.save(); } finally { clearInterval(keepAlive); setEventSink(() => {}); busy = false; }
    }
  };
  // Storage failures keep the durable pre-submit record unresolved; never retry.
  execute().catch(() => {});
}
