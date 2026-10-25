export const clone = value => JSON.parse(JSON.stringify(value, (_, x) => typeof x === 'bigint' ? x.toString() : x));
export const store = {
  async get(key, fallback = null) { return (await chrome.storage.local.get(key))[key] ?? fallback; },
  async set(key, value) { await chrome.storage.local.set({ [key]: clone(value) }); },
  async remove(key) { await chrome.storage.local.remove(key); },
};
let authWrites = Promise.resolve();
export function patchAuth(patch) {
  const next = authWrites.then(async () => { const value = { ...await store.get('auth', {}), ...patch }; await store.set('auth', value); return value; });
  authWrites = next.catch(() => {});
  return next;
}
export const DEFAULTS = Object.freeze({ buyAmountBnb: '0.001', slippageBps: 100, swapSlippageBps: 100,
  rpcUrl: 'https://bsc-dataseed1.bnbchain.org', waitSeconds: 45 });
export async function getConfig() { return { ...DEFAULTS, ...await store.get('config', {}) }; }
export class Journal {
  constructor(data) { this.data = data; }
  static async create(intent, wallet, cfg, id) {
    if (await store.get('operation:' + id)) throw new Error('操作 ID 已存在，禁止重复创建');
    const journal = new Journal({ id, wallet, intent, cfg, status: 'RUNNING', createdAt: new Date().toISOString(), steps: {}, values: {} });
    await journal.save(); return journal;
  }
  static async load(id) {
    if (!/^[0-9a-f-]{36}$/.test(id || '')) throw new Error('无效 operationId');
    const data = await store.get('operation:' + id);
    if (!data) throw new Error('找不到操作记录');
    return new Journal(data);
  }
  async save() { this.data.updatedAt = new Date().toISOString(); await store.set('operation:' + this.data.id, this.data); }
  value(key, value) { if (value !== undefined) this.data.values[key] = value; return this.data.values[key]; }
}
export async function operations() {
  return Object.entries(await chrome.storage.local.get(null)).filter(([key]) => key.startsWith('operation:')).map(([, value]) => value)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
