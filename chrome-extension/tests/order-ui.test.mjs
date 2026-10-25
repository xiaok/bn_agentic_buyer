import test from 'node:test';
import assert from 'node:assert/strict';
import { canQuickSell, orderLabel, orderDetail } from '../src/order-ui.mjs';

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
