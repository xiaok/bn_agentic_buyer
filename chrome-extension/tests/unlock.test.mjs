import test from 'node:test';
import assert from 'node:assert/strict';
import { forceUnlock, resumeOrder, startOrder, view } from '../src/runner.mjs';
import { isFinished, orderLabel, orderDetail } from '../src/order-ui.mjs';
import { validateMessage } from '../src/routes.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);
function fixture(status = 'PENDING') {
  const id = crypto.randomUUID(), key = 'operation:' + id;
  const record = { id, wallet, createdAt: '2026-10-25T13:00:00Z', status, intent: { side: 'sell', token, amount: '50%' },
    lastError: { code: 'API_ERROR', message: 'System abnormality' }, values: { sellAmountRaw: '123' },
    steps: { trade: { name: 'trade', kind: 'contract', status: 'SUBMITTING', executeAttempted: true, txHash: hash, orderId: 'original-order' } } };
  const records = { wallet, auth: { connected: true, sessionId: 'MOCK' }, [key]: structuredClone(record) };
  let writes = 0, failWrites = false, pause;
  globalThis.chrome = { storage: { local: {
    async get(k) { if (pause) await pause; return structuredClone(k === null ? records : { [k]: records[k] }); },
    async set(value) { if (failWrites) throw new Error('storage failed'); writes++; Object.assign(records, structuredClone(value)); },
  } } };
  return { id, key, record, records, writes: () => writes, failWrites(value) { failWrites = value; }, pause(value) { pause = value; } };
}

test('explicitly confirmed manual unlock retains unknown transaction evidence and forbids replay/resume', async () => {
  let network = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { network++; throw new Error('network must not be used'); };
  try {
    for (const status of ['PENDING', 'SUBMISSION_UNKNOWN', 'RUNNING']) {
      const f = fixture(status);
      await assert.rejects(forceUnlock(f.id, false), { code: 'ACKNOWLEDGEMENT_REQUIRED' });
      assert.equal(f.writes(), 0);
      const released = await forceUnlock(f.id, true);
      assert.equal(released.status, 'BLOCKED'); assert.equal(released.manualRelease.previousStatus, status);
      assert.deepEqual(f.records[f.key].steps, f.record.steps);
      assert.deepEqual(f.records[f.key].lastError, f.record.lastError);
      assert.deepEqual(f.records[f.key].values, f.record.values);
      assert(isFinished(released)); assert(!orderLabel(released).includes('成功'));
      assert(orderDetail(released).includes('仍可能成交'));
      const replay = await startOrder({ type: 'SELL', id: f.id, token, amount: '50%' });
      assert.equal(replay.status, 'BLOCKED');
      await assert.rejects(resumeOrder(f.id), { code: 'OPERATION_STOPPED' });
      assert.equal((await view()).busy, false);
    }
    assert.equal(network, 0);
  } finally { globalThis.fetch = oldFetch; }
});
test('manual unlock fails closed on storage failure and releases its temporary mutex', async () => {
  const f = fixture(); f.failWrites(true);
  await assert.rejects(forceUnlock(f.id, true), /storage failed/);
  assert.equal(f.records[f.key].status, 'PENDING');
  f.failWrites(false);
  assert.equal((await forceUnlock(f.id, true)).status, 'BLOCKED');
});
test('unlock and resume cannot run together; wrong-wallet unlock cannot alter the record', async () => {
  const f = fixture(); let release;
  f.pause(new Promise(resolve => { release = resolve; }));
  const unlocking = forceUnlock(f.id, true);
  await assert.rejects(resumeOrder(f.id), { code: 'WALLET_BUSY' });
  await assert.rejects(forceUnlock(f.id, true), { code: 'WALLET_BUSY' });
  f.pause(null); release(); await unlocking;
  const other = fixture(); other.records.wallet = token;
  await assert.rejects(forceUnlock(other.id, true), { code: 'WALLET_CHANGED' });
  assert.equal(other.records[other.key].status, 'PENDING');
});
test('unfinished orders remain visible beyond the newest twelve; completed orders are not rewritten', async () => {
  const f = fixture();
  for (let n = 0; n < 13; n++) {
    const id = crypto.randomUUID(); f.records['operation:' + id] = { ...structuredClone(f.record), id, status: 'SUCCESS', createdAt: `2026-10-25T14:${String(n).padStart(2,'0')}:00Z` };
  }
  assert((await view()).operations.some(op => op.id === f.id));
  await forceUnlock(f.id, true); assert((await view()).operations.every(isFinished));
  const done = fixture('SUCCESS'); await forceUnlock(done.id, true);
  assert.equal(done.writes(), 0); assert(!done.records[done.key].manualRelease);
});
test('only extension pages can request force unlock; a token webpage cannot release the lock', () => {
  const sender = { id: 'ext', frameId: 0, url: 'https://four.meme/token/' + token };
  assert.throws(() => validateMessage({ type: 'FORCE_UNLOCK' }, sender, 'ext'));
  assert(validateMessage({ type: 'FORCE_UNLOCK' }, { ...sender, url: 'chrome-extension://ext/dashboard.html' }, 'ext').own);
});
