import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAbi } from 'viem';
import { Executor, wireTx } from '../scripts/executor.mjs';
import { fail } from '../scripts/core.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const target = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);
const request = { to: target, value: 1000000000000000n, abi: parseAbi(['function buy(address market,uint256 minShares) payable returns (uint256)']), functionName: 'buy', args: [target, 1n] };
const cfg = { waitSeconds: 1 };
const settings = { devMode: { enabled: true, expiresAt: Math.floor(Date.now()/1000) + 3600 } };
function harness(overrides = {}) {
  const data = { id: 'test-operation', steps: {}, values: {} };
  const snapshots = [];
  const journal = { data, save() { snapshots.push(structuredClone(data)); } };
  const wire = wireTx(request);
  const client = { async waitForTransactionReceipt() { return { status: 'success', transactionHash: hash, logs: [] }; }, async getTransaction() { return { from: wallet, to: target, input: wire.data, value: BigInt(wire.value) }; }, ...overrides };
  return { data, snapshots, journal, client };
}
test('normal order calls preview/execute once and no local trade simulation', async () => {
  const h = harness(); const calls = [];
  const baw = { async call(args) { calls.push(args); return args[1] === 'preview' ? { requestId: 'r1', requireConfirmation: false, expiresAt: Date.now()+10000 } : { status: 'BROADCASTED', txHash: hash, orderId: 'o1' }; } };
  const e = new Executor(h.client, cfg, wallet, settings, h.journal, baw);
  await e.contract('trade', request); await e.contract('trade', request);
  assert.equal(calls.filter(x => x[1] === 'preview').length, 1);
  assert.equal(calls.filter(x => x[1] === 'execute').length, 1);
  assert(h.snapshots.some(x => x.steps.trade?.status === 'SUBMITTING' && x.steps.trade.executeAttempted));
  assert.equal(h.data.steps.trade.status, 'CONFIRMED');
});
test('execute timeout survives resume without duplicate execution', async () => {
  const h = harness(); let executions = 0;
  const baw = { async call(args) { if (args[1] === 'preview') return { requestId: 'r', requireConfirmation: false }; executions++; throw fail('COMMAND_TIMEOUT', 'timeout'); } };
  const e = new Executor(h.client, cfg, wallet, settings, h.journal, baw);
  await assert.rejects(e.contract('trade', request), { code: 'SUBMISSION_UNKNOWN' });
  const resumed = new Executor(h.client, cfg, wallet, settings, h.journal, { async call() { throw new Error('must not call BAW again'); } });
  await assert.rejects(resumed.contract('trade', request), { code: 'SUBMISSION_UNKNOWN' });
  assert.equal(executions, 1);
});
test('App pending order reconciles exact orderId and never executes twice', async () => {
  const h = harness(); let executions = 0;
  const baw = { async call(args) {
    if (args[1] === 'preview') return { requestId: 'r', requireConfirmation: true };
    if (args[1] === 'execute') { executions++; return { status: 'PENDING_CONFIRMATION', orderId: 'own-order' }; }
    return { items: [{ orderId: 'other-order', txHash: '0x'+'b'.repeat(64) }, { orderId: 'own-order', txHash: hash }] };
  } };
  const e = new Executor(h.client, cfg, wallet, settings, h.journal, baw);
  await assert.rejects(e.contract('trade', request), { code: 'PENDING_CONFIRMATION' });
  await e.contract('trade', request);
  assert.equal(executions, 1);
  assert.equal(h.data.steps.trade.txHash, hash);
});
test('wrong chain transaction stops the workflow despite backend success', async () => {
  const h = harness({ async getTransaction() { return { from: wallet, to: wallet, input: '0x', value: 0n }; } });
  const baw = { async call(args) { return args[1] === 'preview' ? { requestId: 'r', requireConfirmation: false } : { status: 'BROADCASTED', txHash: hash }; } };
  const e = new Executor(h.client, cfg, wallet, settings, h.journal, baw);
  await assert.rejects(e.contract('trade', request), { code: 'RECEIPT_MISMATCH' });
  assert.notEqual(h.data.steps.trade.status, 'CONFIRMED');
});
test('failed preview never executes', async () => {
  const h = harness(); let executions = 0;
  const e = new Executor(h.client, cfg, wallet, settings, h.journal, { async call(args) { if (args[1] === 'execute') executions++; throw fail('RISK_BLOCKED', 'blocked'); } });
  await assert.rejects(e.contract('trade', request), { code: 'RISK_BLOCKED' });
  assert.equal(executions, 0);
});
test('Developer Mode blocks before preview when disabled', async () => {
  const h = harness();
  const e = new Executor(h.client, cfg, wallet, { devMode: { enabled: false } }, h.journal, { async call() { throw new Error('must not call'); } });
  await assert.rejects(e.contract('trade', request), { code: 'DEVELOPER_MODE_REQUIRED' });
});
