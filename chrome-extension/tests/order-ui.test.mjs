import test from 'node:test';
import assert from 'node:assert/strict';
import { canQuickSell, orderLabel, orderDetail, orderHash } from '../src/order-ui.mjs';

test('quick sell is limited to successful buys belonging to the currently connected wallet', () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const op = { wallet, status: 'SUCCESS', intent: { side: 'buy' } };
  const state = { wallet, connected: true };
  assert.equal(canQuickSell(op, state), true);
  for (const status of ['RUNNING', 'SUBMISSION_UNKNOWN', 'FAILED', 'PENDING']) assert.equal(canQuickSell({ ...op, status }, state), false);
  assert.equal(canQuickSell({ ...op, intent: { side: 'sell' } }, state), false);
  assert.equal(canQuickSell(op, { ...state, connected: false }), false);
  assert.equal(canQuickSell(op, { ...state, wallet: '0x2222222222222222222222222222222222222222' }), false);
});
test('unknown submissions never show success; confirmed trades do not show stale progress errors', () => {
  assert.equal(orderLabel({ status: 'SUCCESS', intent: { side: 'buy' } }), '买入成功');
  assert.equal(orderLabel({ status: 'SUCCESS', intent: { side: 'sell' } }), '卖出成功');
  assert(!orderLabel({ status: 'SUBMISSION_UNKNOWN', intent: { side: 'buy' } }).includes('成功'));
  assert.equal(orderDetail({ status: 'SUCCESS', error: { message: 'old transient error' } }), '交易已在链上确认');
});

test('trade link does not regress to an approval inserted later in the journal', () => {
  const trade = '0x' + 'a'.repeat(64), approval = '0x' + 'b'.repeat(64), final = '0x' + 'c'.repeat(64);
  const op = { steps: [{ name: 'trade', txHash: trade }, { name: 'trade-approve', txHash: approval }] };
  assert.equal(orderHash(op), trade);
  assert.equal(orderHash({ ...op, result: { txHash: final } }), final);
  assert.equal(orderHash({ steps: [{ name: 'trade-approve', txHash: approval }] }), approval);
});
test('confirmed sell awaiting settlement never asks for App confirmation or claims completion', () => {
  const op = { status: 'PENDING', intent: { side: 'sell' }, steps: [{ name: 'trade', status: 'CONFIRMED' }], error: { message: 'Quote unavailable' } };
  assert.equal(orderLabel(op), '卖出已确认／待结算');
  assert.match(orderDetail(op), /后续 BNB 结算未完成/);
  assert.match(orderDetail(op), /Quote unavailable/);
  assert(!orderLabel({ ...op, steps: [{ name: 'trade-approve', status: 'CONFIRMED' }] }).includes('卖出已确认'));
  assert(!orderLabel({ ...op, intent: { side: 'buy' } }).includes('卖出已确认'));
  assert.equal(orderLabel({ ...op, status: 'SUCCESS' }), '卖出成功');
  assert.match(orderLabel({ ...op, manualRelease: true }), /结果未核实/);
});
