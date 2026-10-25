import { tokenFromUrl } from './routes.mjs';
import { tokenFromPage } from './page-address.mjs';
import { isFinished, orderHash, orderLabel, orderDetail } from './order-ui.mjs';
import { createNotice } from './notice.mjs';

if (window.top === window && !document.querySelector('agent-trade-chrome')) {
  const host = document.createElement('agent-trade-chrome');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed!important;right:18px!important;bottom:24px!important;z-index:2147483647!important;font:13px/1.5 system-ui,sans-serif!important;color:#f4f5f7!important}
    .box{width:280px;background:#151922;border:1px solid #404856;border-radius:14px;padding:14px;box-shadow:0 12px 40px #0006}
    .head{display:flex;justify-content:space-between;align-items:center;font-weight:700}.label{font-size:11px;color:#a8b3c5;letter-spacing:.08em}
    button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:9px 12px;background:#f5c842;color:#151515;font-weight:750}
    button:disabled{opacity:.5;cursor:default}.settings{background:transparent;color:#bac5d7;font-size:12px;padding:4px}
    .address{font:11px/1.6 ui-monospace,monospace;overflow-wrap:anywhere;color:#d3dcec;margin:9px 0;min-height:34px}
    .buy{width:100%;margin-bottom:7px}.status{white-space:pre-wrap;font-size:12px;color:#afbdd0;overflow-wrap:anywhere;max-height:140px;overflow:auto}
    .resume{background:#2b3547;color:#edf1f7;margin:8px 0 0;width:100%}.hidden{display:none}a{color:#f5c842}
    .platforms{display:flex;gap:8px;margin:9px 0 4px}.platforms a{flex:1;text-align:center;text-decoration:none;border:1px solid #404856;border-radius:6px;padding:4px;font-size:11px}.platforms a:hover{background:#30394b}
  </style><div class="box"><div class="head"><span>Agent Trade</span><button class="settings" type="button">设置 ↗</button></div>
  <nav class="platforms" aria-label="交易平台"><a href="https://gang.fun/" target="_blank" rel="noopener noreferrer">Gang ↗</a><a href="https://flap.sh/apps/agent-bonding-curve?lang=zh" target="_blank" rel="noopener noreferrer">Flap ↗</a><a href="https://four.meme/zh-TW/contract/1778027615735" target="_blank" rel="noopener noreferrer">Four ↗</a></nav><div class="label">BSC · 一键买入</div><div class="address"></div><button class="buy" type="button">连接钱包</button>
  <div class="status">读取扩展状态…</div><button class="resume hidden" type="button">继续原订单</button></div>`;
  document.documentElement.appendChild(host);
  const $ = selector => shadow.querySelector(selector);
  const notify = createNotice(shadow);
  let token = null, config = null, connected = false, pending = null, posting = false, selection = null;
  let watchedOrder = null, watchedState;
  const cards = new Map();
  const send = async message => { const result = await chrome.runtime.sendMessage(message); if (!result?.ok) throw new Error(result?.error?.message || '扩展连接中断；请打开设置查看原订单'); return result.data; };
  $('.settings').addEventListener('click', event => { if (event.isTrusted) send({ type: 'OPEN' }).catch(showError); });
  const showError = error => { $('.status').textContent = error.message; };
  function update() {
    if (selection && (selection.url !== location.href || !selection.element.isConnected || candidateFor(selection.element) !== selection.token)) selection = null;
    token = tokenFromPage(document, location.href) || selection?.token || null;
    $('.address').textContent = token || '请打开币的详情，或使用条目旁的买入按钮。';
    $('.buy').textContent = connected ? `买入 ${config?.buyAmountBnb || '0.001'} BNB` : '连接钱包';
    $('.buy').disabled = posting || (connected && (!token || !config || !!pending));
    $('.resume').classList.toggle('hidden', !pending || pending.status === 'RUNNING' || posting);
    for (const item of cards.values()) { item.button.textContent = connected ? `买 ${config?.buyAmountBnb || '0.001'} BNB` : '连接后买入'; item.button.disabled = posting || !!pending; }
  }
  async function submit(clickedToken) {
    if (posting || pending) return;
    if (!connected || !clickedToken || !config) { await send({ type: 'OPEN' }).catch(showError); return; }
    const amount = config.buyAmountBnb, id = crypto.randomUUID();
    watchedOrder = id; watchedState = undefined;
    posting = true; update(); $('.status').textContent = '正在提交，请勿重复点击…';
    notify('正在买入…', `${amount} BNB\n${clickedToken}\n请勿重复点击`);
    try { await send({ type: 'BUY', token: clickedToken, amount, id }); await refresh(); }
    catch (e) { showError(e); notify('提交未完成', e.message, 'error'); } finally { posting = false; update(); }
  }
  $('.buy').addEventListener('click', async event => {
    if (!event.isTrusted) return;
    await submit(token);
  });
  function candidateFor(element) {
    if (location.hostname === 'flap.sh') {
      const value = element.getAttribute('data-agent-trade-market');
      return /^0x[0-9a-fA-F]{40}$/.test(value || '') ? value : null;
    }
    try {
      const url = new URL(element.href);
      return url.hostname === location.hostname && /\/(?:token|market)\/0x[0-9a-fA-F]{40}(?:\/|$)/.test(url.pathname) ? tokenFromUrl(url.href) : null;
    } catch { return null; }
  }
  function scanCards() {
    const nodes = location.hostname === 'flap.sh' ? document.querySelectorAll('[data-agent-trade-market]') : document.querySelectorAll('a[href]');
    for (const [element, record] of cards) if (!element.isConnected || candidateFor(element) !== record.token) { record.host.remove(); cards.delete(element); }
    for (const element of nodes) {
      const address = candidateFor(element);
      if (!address || cards.has(element) || !element.getClientRects().length || cards.size >= 200) continue;
      // Avoid decorating the activity ticker; market tables and token cards remain.
      if (location.hostname === 'gang.fun' && /买了|bought/i.test(element.textContent)) continue;
      const badge = document.createElement('agent-trade-buy');
      const root = badge.attachShadow({ mode: 'closed' });
      root.innerHTML = '<style>:host{all:initial!important;display:inline-flex!important;position:relative!important;z-index:40!important;margin:4px!important;vertical-align:middle!important}button{border:1px solid #9d7e1d;border-radius:6px;background:#f3c742;color:#151515;padding:5px 8px;font:700 11px/1.4 system-ui,sans-serif;cursor:pointer;white-space:nowrap}button:disabled{opacity:.45;cursor:default}</style><button type="button"></button>';
      const button = root.querySelector('button'); button.title = address;
      const choose = event => { if (event.isTrusted) { selection = { token: address, element, url: location.href }; update(); } };
      badge.addEventListener('pointerenter', choose);
      button.addEventListener('click', async event => {
        if (!event.isTrusted) return;
        event.preventDefault(); event.stopPropagation();
        if (candidateFor(element) !== address) { showError(new Error('条目地址变化，请重新点击')); return; }
        selection = { token: address, element, url: location.href }; update(); await submit(address);
      });
      element.appendChild(badge); cards.set(element, { host: badge, button, token: address });
    }
    update();
  }
  $('.resume').addEventListener('click', async event => {
    if (!event.isTrusted || !pending || posting) return;
    posting = true; update();
    try { await send({ type: 'RESUME', id: pending.id }); await refresh(); }
    catch (e) { showError(e); } finally { posting = false; update(); }
  });
  async function refresh() {
    try {
      const state = await send({ type: 'VIEW' }); config = state.config; connected = state.connected;
      pending = state.operations.find(op => !isFinished(op));
      const watched = state.operations.find(op => op.id === watchedOrder);
      if (watched && watchedState !== watched.status) {
        watchedState = watched.status;
        notify(orderLabel(watched), orderDetail(watched), watched.status === 'SUCCESS' ? 'success' : isFinished(watched) ? 'error' : 'pending', orderHash(watched));
      }
      const current = pending || state.operations.find(op => op.intent.token.toLowerCase() === token?.toLowerCase()) || watched;
      if (current) {
        const hash = orderHash(current);
        $('.status').textContent = `${orderLabel(current)}\n${orderDetail(current)}`;
        if (/^0x[0-9a-f]{64}$/i.test(hash || '')) { const a = document.createElement('a'); a.textContent = '查看交易 ↗'; a.href = 'https://bscscan.com/tx/' + hash; a.target = '_blank'; a.rel = 'noopener noreferrer'; $('.status').appendChild(document.createElement('br')); $('.status').appendChild(a); }
      } else $('.status').textContent = connected ? '点击即按显示金额执行 · gas 另计' : '先在扩展设置里完成 Binance App 配对';
      // An interrupted RUNNING operation must be resumed explicitly after a restart.
      if (pending && !state.busy) $('.resume').classList.remove('hidden');
      update();
      if (pending && !state.busy && !posting) $('.resume').classList.remove('hidden');
    } catch (e) { showError(e); }
  }
  update(); scanCards(); refresh(); setInterval(() => { scanCards(); refresh(); }, 1000);
}
