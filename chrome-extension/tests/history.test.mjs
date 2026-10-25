import test from 'node:test';
import assert from 'node:assert/strict';
import { historyTransactionHash } from '../src/history.mjs';
import { Baw } from '../src/baw.mjs';
import { Executor } from '../src/engine/executor.mjs';

const hash = '0x' + 'a'.repeat(64), otherHash = '0x' + 'b'.repeat(64);
const wallet = '0x1111111111111111111111111111111111111111', target = '0x2222222222222222222222222222222222222222';

test('history matches exact orderId or binanceTxId, rejects ambiguity and other chains', () => {
  assert.equal(historyTransactionHash({ list: [{ orderId: 'other', txHash: otherHash }, { binanceTxId: 'own', txHash: hash, binanceChainId: '56' }] }, 'own'), hash);
  assert.equal(historyTransactionHash([{ orderId: 'own', txHashList: [{ binanceChainId: '1', txHash: otherHash }, { binanceChainId: '56', txHash: hash }] }], 'own'), hash);
  assert.equal(historyTransactionHash([{ binanceTxId: 'own', txHash: hash, binanceChainId: '1' }], 'own'), null);
  assert.equal(historyTransactionHash([{ orderId: 'not-own', txHash: hash }], 'own'), null);
  assert.throws(() => historyTransactionHash([{ binanceTxId: 'own', txHash: hash }, { orderId: 'own', txHash: otherHash }], 'own'), { code: 'AMBIGUOUS_HISTORY' });
});
test('history HTTP requests use official plural chain filter, size/time bounds and follow cursors', async () => {
  const requests = [], start = Date.now() - 3600000;
  const baw = new Baw({}, { async request(path) {
    const u = new URL(path, 'https://www.binance.com'); requests.push(u);
    assert.equal(u.searchParams.get('binanceChainIds'), '56'); assert.equal(u.searchParams.has('binanceChainId'), false);
    assert.equal(u.searchParams.get('size'), '100'); assert.equal(Number(u.searchParams.get('startTime')), start);
    assert(Number(u.searchParams.get('endTime')) >= start);
    if (u.pathname.endsWith('tx-history-pending')) return { list: [] };
    if (!u.searchParams.has('nextToken')) return { list: [{ orderId: 'unrelated', txHash: otherHash }], nextToken: 'page-two+/' };
    assert.equal(u.searchParams.get('nextToken'), 'page-two+/');
    return { list: [{ binanceTxId: 'own', txHash: hash }] };
  } });
  const result = await baw.call(['wallet', 'tx-history', '--orderId', 'own', '--startTime', String(start)]);
  assert.equal(historyTransactionHash(result, 'own'), hash); assert.equal(requests.length, 3);
});
test('exact confirmed history is usable even when pending-history endpoint fails', async () => {
  const baw = new Baw({}, { async request(path) {
    if (path.includes('tx-history-pending')) throw new Error('System abnormality');
    return { list: [{ binanceTxId: 'own', txHash: hash }] };
  } });
  assert.equal(historyTransactionHash(await baw.call(['wallet', 'tx-history', '--orderId', 'own']), 'own'), hash);
  await assert.rejects(baw.call(['wallet', 'tx-history', '--orderId', 'missing']), /System abnormality/);
});
test('App-confirmed binanceTxId is reconciled by receipt and exact calldata without submitting again', async () => {
  const step = { name: 'trade', kind: 'contract', status: 'PENDING_CONFIRMATION', executeAttempted: true, orderId: 'own', request: { to: target, data: '0x1234', value: '0' } };
  const journal = { data: { id: 'old-order', createdAt: new Date().toISOString(), steps: { trade: step } }, async save() {} };
  const client = { async waitForTransactionReceipt() { return { status: 'success', transactionHash: hash, logs: [] }; }, async getTransaction() { return { from: wallet, to: target, input: '0x1234', value: 0n }; } };
  const baw = { async call(args) { assert.deepEqual(args.slice(0,2), ['wallet', 'tx-history']); assert(args.includes('own')); return { list: [{ binanceTxId: 'own', txHash: hash }] }; } };
  const executor = new Executor(client, { waitSeconds: 1 }, wallet, {}, journal, baw);
  await executor.contract('trade', {}); assert.equal(step.status, 'CONFIRMED'); assert.equal(step.txHash, hash);
  step.status = 'PENDING_CONFIRMATION'; delete step.txHash;
  client.getTransaction = async () => ({ from: wallet, to: wallet, input: '0x095ea7b3', value: 0n });
  await assert.rejects(executor.contract('trade', {}), { code: 'RECEIPT_MISMATCH' });
  assert.notEqual(step.status, 'CONFIRMED');
});

test('large Binance order IDs remain exact strings; unsafe numeric IDs cannot match', () => {
  const id = '26102500000000000001', rounded = Number(id);
  assert.equal(historyTransactionHash([{ binanceTxId: id, txHash: hash }], id), hash);
  assert.equal(historyTransactionHash([{ binanceTxId: rounded, txHash: hash }], String(rounded)), null);
  assert.equal(historyTransactionHash([{ binanceTxId: String(rounded), txHash: hash }], rounded), null);
  assert.equal(historyTransactionHash([{ binanceTxId: '26102500000000000002', txHash: otherHash }], id), null);
  assert.equal(historyTransactionHash([{ orderId: 42, txHash: hash }], '42'), hash);
});
test('top-level history hash cannot hide a conflicting BSC child hash', () => {
  assert.throws(() => historyTransactionHash([{ binanceTxId: 'own', binanceChainId: '56', txHash: hash, txHashList: [{ binanceChainId: '56', txHash: otherHash }] }], 'own'), { code: 'AMBIGUOUS_HISTORY' });
  assert.equal(historyTransactionHash([{ binanceTxId: 'own', binanceChainId: '56', txHash: hash, txHashList: [{ binanceChainId: '56', txHash: hash }] }], 'own'), hash);
});
test('nested hashes require a BSC chain identity and cannot escape a different-chain parent', () => {
  assert.equal(historyTransactionHash([{ orderId: 'own', txHashList: [{ txHash: hash }] }], 'own'), null);
  assert.equal(historyTransactionHash([{ orderId: 'own', binanceChainId: '56', txHashList: [{ txHash: hash }] }], 'own'), hash);
  assert.equal(historyTransactionHash([{ binanceChainId: '1', child: { orderId: 'own', txHash: hash } }], 'own'), null);
});

test('a conflicting history page is never hidden by a successful sibling endpoint', async () => {
  const baw = new Baw({}, { async request(path) {
    return path.includes('tx-history-pending')
      ? { list: [{ orderId: 'own', txHash: hash }, { orderId: 'own', txHash: otherHash }] }
      : { list: [{ orderId: 'own', txHash: hash }] };
  } });
  await assert.rejects(baw.call(['wallet', 'tx-history', '--orderId', 'own']), { code: 'AMBIGUOUS_HISTORY' });
});
