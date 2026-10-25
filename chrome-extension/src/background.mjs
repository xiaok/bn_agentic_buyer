import { transport, startLogin, pollLogin, signOut, initializeSession } from './baw.mjs';
import { store, getConfig, patchAuth } from './storage.mjs';
import { view, startOrder, resumeOrder, validateConfig } from './runner.mjs';
import { validateMessage } from './routes.mjs';

const ready = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
transport.listenForCookies();
chrome.action.onClicked.addListener(() => { chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); });
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    await ready;
    const { own } = validateMessage(message, sender, chrome.runtime.id);
    switch (message.type) {
      case 'VIEW': {
        const result = await view();
        if (!own) { delete result.login; result.operations = result.operations.map(op => ({ ...op, timings: undefined })); }
        return result;
      }
      case 'OPEN': await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }); return { status: 'OPENED' };
      case 'CONNECT': return startLogin();
      case 'POLL_LOGIN': return pollLogin();
      case 'SIGN_OUT': if ((await view()).busy) throw new Error('请等待当前操作结束'); return signOut();
      case 'SESSION': {
        return initializeSession();
      }
      case 'CONFIG': {
        const keys = ['buyAmountBnb', 'slippageBps', 'swapSlippageBps', 'waitSeconds'];
        if (!message.config || Object.keys(message.config).some(k => !keys.includes(k))) throw new Error('不支持的配置项');
        const cfg = { ...await getConfig(), ...message.config }; validateConfig(cfg);
        await store.set('config', cfg); return { status: 'CONFIG_SAVED' };
      }
      case 'BUY': return startOrder(message);
      case 'SELL': return startOrder(message);
      case 'RESUME': return resumeOrder(message.id);
      default: throw new Error('不支持的指令');
    }
  };
  handle().then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: { code: error.code || 'ERROR', message: error.shortMessage || error.message, ...error.data } }));
  return true;
});
