import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, parseAbiParameters, encodeEventTopics, parseAbi, decodeFunctionData } from 'viem';
import { units, sellQuantity, shareBps, bps, erc20Delta, NATIVE } from '../src/engine/core.mjs';
import { parseProbeData, gangBuy, gangSell, buildFlap, FLAP } from '../src/engine/adapters.mjs';

test('amount conversion is exact, never rounds or accepts scientific notation', () => {
  assert.equal(units('0.001'), 1000000000000000n);
  assert.equal(units('12.345678', 6), 12345678n);
  assert.throws(() => units('0.0000001', 6));
  for (const s of ['1e3', '-1', 'NaN', '0', '1;echo secret']) assert.throws(() => units(s));
});
test('sell percent rounds down; no implicit sell-all', () => {
  assert.equal(sellQuantity('50%', 101n, 18), 50n);
  assert.equal(sellQuantity('all', 101n, 18), 101n);
  assert.throws(() => sellQuantity(undefined, 101n, 18));
  assert.throws(() => sellQuantity('100.01%', 101n, 18));
  assert.equal(shareBps('0.01%'), 1n);
  assert.throws(() => shareBps('1000'));
});
test('slippage is integer bps and cannot silently become 100%', () => {
  assert.equal(bps('100'), 100);
  for (const s of ['10000', '1.5', '-1', '1e2']) assert.throws(() => bps(s));
});
const revert = text => '0x08c379a0' + encodeAbiParameters(parseAbiParameters('string'), [text]).slice(2);
test('Flap parses complete Error(string), preserves zeros and rejects missing/duplicate fields', () => {
  assert.deepEqual(parseProbeData(revert('MIN_SHARES=0;RULES_OK=1;END'), ['MIN_SHARES', 'RULES_OK']), { MIN_SHARES: '0', RULES_OK: '1' });
  for (const s of ['MIN_SHARES=1;', 'MIN_SHARES=1;END extra', 'RULES_OK=1;END', 'MIN_SHARES=1;MIN_SHARES=2;END']) assert.throws(() => parseProbeData(revert(s), ['MIN_SHARES']));
  assert.throws(() => parseProbeData(revert('MIN_SHARES=1;END').slice(0, 40), ['MIN_SHARES']));
});
test('Gang buy respects wallet cap and refunds instead of overspending', () => {
  const curve = [NATIVE, NATIVE, 0n, 0n, units('15'), units('5'), false, false];
  const uncapped = gangBuy(curve, units('0.001'), units('10000000'));
  const capped = gangBuy(curve, units('0.001'), units('1'));
  assert(uncapped.amount > units('1'));
  assert.equal(capped.amount, units('1'));
  assert(capped.refund > 0n && capped.refund < units('0.001'));
  assert.throws(() => gangBuy(curve, units('0.001'), 0n));
});
test('Gang immediate roundtrip cannot manufacture quote profits', () => {
  const curve = [NATIVE, NATIVE, 0n, 0n, units('15'), units('5'), false, false];
  const gross = units('0.01');
  const q = gangBuy(curve, gross, units('10000000'));
  const after = [...curve]; after[2] = gross - q.refund - q.fee; after[3] = q.amount;
  const out = gangSell(after, q.amount);
  assert(out > 0n && out < gross);
});
test('only exact asset/wallet Transfer logs contribute to funding', () => {
  const token = '0x1111111111111111111111111111111111111111';
  const wallet = '0x2222222222222222222222222222222222222222';
  const other = '0x3333333333333333333333333333333333333333';
  const abi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const log = (asset, from, to, n) => ({ address: asset, topics: encodeEventTopics({ abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [n]) });
  const receipt = { logs: [log(token, other, wallet, 50n), log(token, wallet, other, 2n), log(other, other, wallet, 900n), log(token, other, other, 900n)] };
  assert.equal(erc20Delta(receipt, token, wallet), 48n);
});
test('Flap ERC20 buy encodes raw quote units, zero native value, and Market as spender', async () => {
  const wallet = '0x1111111111111111111111111111111111111111';
  const market = '0x2222222222222222222222222222222222222222';
  const quote = '0x3333333333333333333333333333333333333333';
  const probeAddress = '0x4444444444444444444444444444444444444444';
  const responses = {
    assetProbe: `MARKET=${market};QUOTE=${quote};DECIMALS=6`,
    actionStatusProbe: 'PHASE=1;BUY_OK=1',
    buyCapacityProbe: 'PHASE=1;ID=1;ROOM_SHARES=100',
    buyPlanProbe: 'MIN_SHARES=99;BUY_SHARES=100;RULES_OK=1;BLOCK=7',
  };
  const client = { async getBlockNumber() { return 7n; }, async call(request) {
    assert.equal(request.to, probeAddress); assert.equal(request.account, wallet);
    assert.equal(request.value, 0n); assert.equal(request.blockNumber, 7n);
    const d = decodeFunctionData({ abi: FLAP.probe, data: request.data });
    if (d.functionName === 'buyPlanProbe') assert.deepEqual(d.args, [1234567n, 100n]);
    throw { data: revert(responses[d.functionName] + ';END') };
  } };
  const plan = await buildFlap(client, { market, probe: probeAddress, quote, quoteDecimals: 6 }, wallet, 'buy', 1234567n, 100);
  assert.equal(plan.approval.spender, market); assert.equal(plan.approval.amount, 1234567n);
  assert.equal(plan.tx.functionName, 'buyWithQuote'); assert.equal(plan.tx.value, 0n);
  assert.deepEqual(plan.tx.args, [market, 1234567n, 99n]);
});
