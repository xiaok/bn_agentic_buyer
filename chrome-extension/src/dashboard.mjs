import { drawPairingQr } from './pairing.mjs';
import { isFinished, orderHash, orderLabel, orderDetail, canQuickSell } from './order-ui.mjs';
import { createNotice } from './notice.mjs';

const $ = id => document.getElementById(id);
let state, posting = false, loginPending = false, pairingUrl;
let watchedOrder, watchedState;
const notify = createNotice(document.body);
const send = async message => { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error?.message || '扩展未响应；先查询原订单，不要重复买入'); return result.data; };
const feedback = text => { $('feedback').textContent = text; };
const attempt = work => async event => { event?.preventDefault(); if (event && !event.isTrusted) return; try { await work(); } catch (e) { feedback(e.message); } };
function showPairing(login) {
  $('pairing').hidden = false;
  $('pairing-code').textContent = login.pairingCode;
  $('pairing-url').href = login.url;
  if (!Number.isFinite(Number(login.expireAt)) || Number(login.expireAt) <= Date.now()) {
    loginPending = false; $('pairing-qr').hidden = true;
    $('pairing-url').hidden = true;
    $('pairing-state').textContent = '二维码已过期，请重新点击“连接 Binance Agentic Wallet”。';
    return;
  }
  loginPending = true; $('pairing-qr').hidden = false; $('pairing-url').hidden = false;
  if (pairingUrl !== login.url) {
    pairingUrl = login.url;
    $('pairing-state').textContent = '等待使用 Binance App 扫码；扫码后核对配对码并确认连接。';
    drawPairingQr($('pairing-qr'), login.url).catch(() => {
      if (pairingUrl !== login.url) return;
      $('pairing-qr').hidden = true;
      $('pairing-state').textContent = '二维码显示失败，请点击上方链接，在 Binance 官方页面扫码。';
    });
  }
}
function controls() {
  const pending = state?.operations.some(op => !isFinished(op));
  for (const id of ['buy', 'sell-half', 'sell-all']) $(id).disabled = posting || !state?.connected || state.busy || pending;
  for (const button of document.querySelectorAll('[data-quick-sell]')) button.disabled = posting || !state?.connected || state.busy || pending;
  $('buy').textContent = `买入 ${state?.config.buyAmountBnb || '0.001'} BNB`;
}
async function refresh() {
  state = await send({ type: 'VIEW' }); $('connection').textContent = state.connected ? '已连接' : '未连接';
  const watched = state.operations.find(op => op.id === watchedOrder);
  if (watched && watchedState !== watched.status) {
    watchedState = watched.status;
    const message = `${orderLabel(watched)} · ${orderDetail(watched)}`;
    feedback(message);
    notify(orderLabel(watched), orderDetail(watched), watched.status === 'SUCCESS' ? 'success' : isFinished(watched) ? 'error' : 'pending', orderHash(watched));
  }
  if (state.login && !state.connected) {
    showPairing(state.login);
  } else { loginPending = false; $('pairing').hidden = true; pairingUrl = undefined; }
  $('wallet').textContent = state.wallet || '在 Binance App 配对后，核对这里的钱包地址。';
  if (state.connected) $('wallet-note').textContent = `Developer Mode：${state.walletSettings?.devMode?.enabled ? '已开启' : '请在 Binance App 设置中开启'}。${state.walletSettings?.tradeAllTokens === false ? '请检查 App 中允许交易的 token 范围。' : ''}请核对上方 BSC 钱包地址。`;
  if (!document.querySelector('#config :focus')) {
    $('amount').value = state.config.buyAmountBnb; $('slippage').value = state.config.slippageBps; $('swap-slippage').value = state.config.swapSlippageBps;
  }
  controls(); $('orders').replaceChildren();
  for (const op of state.operations) {
    const box = document.createElement('div'); box.className = 'order'; box.dataset.orderId = op.id;
    const title = document.createElement('div'); title.className = 'order-title';
    const description = document.createElement('strong'); description.textContent = `${op.intent.side === 'buy' ? '买入' : '卖出'} ${op.intent.amount}${op.intent.side === 'buy' ? ' BNB' : ''}`;
    const badge = document.createElement('span'); badge.textContent = orderLabel(op); badge.className = op.status === 'SUCCESS' ? 'good' : isFinished(op) ? 'bad' : '';
    title.append(description, badge); box.append(title);
    const token = document.createElement('p'); token.className = 'mono'; token.textContent = op.intent.token; box.append(token);
    const details = document.createElement('p'); details.textContent = orderDetail(op); box.append(details);
    const hash = orderHash(op);
    if (/^0x[0-9a-f]{64}$/i.test(hash || '')) { const a = document.createElement('a'); a.href = 'https://bscscan.com/tx/' + hash; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = '查看链上交易 ↗'; box.append(a); }
    if (canQuickSell(op, state)) {
      const actions = document.createElement('div'); actions.className = 'row';
      for (const amount of ['25%', '50%', 'all']) {
        const button = document.createElement('button'); button.className = 'secondary'; button.type = 'button';
        button.dataset.quickSell = amount; button.textContent = amount === 'all' ? '卖出全部' : `卖出 ${amount}`;
        button.addEventListener('click', attempt(() => order('SELL', amount, op.intent.token)));
        actions.append(button);
      }
      const note = document.createElement('p'); note.className = 'note'; note.textContent = '按当前钱包中该币的持仓比例卖出。';
      box.append(actions, note);
    }
    if (!isFinished(op)) {
      const button = document.createElement('button'); button.className = 'secondary'; button.textContent = 'App 确认后／中断后，继续原订单'; button.disabled = state.busy || posting;
      button.addEventListener('click', attempt(async () => { await send({ type: 'RESUME', id: op.id }); feedback('正在继续原订单，不重复提交已发送步骤。'); await refresh(); })); box.append(button);
    }
    const raw = document.createElement('details'), summary = document.createElement('summary'), pre = document.createElement('pre'); summary.textContent = '操作 ID 与耗时'; pre.textContent = JSON.stringify({ id: op.id, timings: op.timings, steps: op.steps }, null, 2); raw.append(summary, pre); box.append(raw); $('orders').append(box);
  }
  controls();
}
$('connect').addEventListener('click', attempt(async () => {
  const result = await send({ type: 'CONNECT' });
  if (result.status === 'CONNECTED') { await send({ type: 'SESSION' }); await refresh(); return; }
  showPairing(result);
  feedback('请用 Binance App 扫描二维码，核对配对码并确认连接，无需输入。');
}));
$('check').addEventListener('click', attempt(async () => { const r = loginPending ? await send({ type: 'POLL_LOGIN' }) : await send({ type: 'SESSION' }); if (r.status === 'CONNECTED') { loginPending = false; $('pairing').hidden = true; $('wallet-note').textContent = r.devMode?.enabled === false ? '请在 App 开启 Developer Mode。' : '请核对钱包地址；此扩展使用独立客户端会话。'; } await refresh(); }));
$('signout').addEventListener('click', attempt(async () => { await send({ type: 'SIGN_OUT' }); loginPending = false; $('pairing').hidden = true; await refresh(); }));
$('config').addEventListener('submit', attempt(async () => {
  await send({ type: 'CONFIG', config: { buyAmountBnb: $('amount').value.trim(), slippageBps: Number($('slippage').value), swapSlippageBps: Number($('swap-slippage').value) } }); feedback('默认参数已保存。'); await refresh();
}));
async function order(type, amount, token = $('token').value.trim()) {
  if (posting || state.busy || state.operations.some(op => !isFinished(op))) return;
  posting = true; controls(); const id = crypto.randomUUID(); watchedOrder = id; watchedState = undefined;
  const title = type === 'BUY' ? '正在买入…' : '正在卖出…';
  feedback('正在提交，请勿重复点击…'); notify(title, `${token}\n正在提交，请勿重复点击`);
  try { await send({ type, token, amount, id }); feedback('订单已提交，正在等待链上确认。'); }
  catch (e) { notify('提交未完成', e.message, 'error'); throw e; }
  finally { posting = false; await refresh(); }
}
$('buy').addEventListener('click', attempt(() => order('BUY', state.config.buyAmountBnb)));
$('sell-half').addEventListener('click', attempt(() => order('SELL', '50%')));
$('sell-all').addEventListener('click', attempt(() => order('SELL', 'all')));
$('refresh').addEventListener('click', attempt(refresh));
refresh().catch(e => feedback(e.message));
setInterval(async () => {
  try {
    if (loginPending) {
      const result = await send({ type: 'POLL_LOGIN' });
      if (result.status === 'CONNECTED') { loginPending = false; $('pairing').hidden = true; feedback('已连接。请核对钱包地址。'); }
    }
    await refresh();
  } catch (e) { if (loginPending) { loginPending = false; $('pairing-state').textContent = e.message; } else feedback(e.message); }
}, 1500);
