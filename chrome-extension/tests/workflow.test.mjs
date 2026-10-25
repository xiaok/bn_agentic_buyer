import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeAbiParameters, parseAbiParameters, encodeEventTopics, parseAbi } from 'viem';
import { runTrade } from '../src/engine/trade.mjs';
import { GANG_PADS, ERC20, gangBuy } from '../src/engine/adapters.mjs';
import { units, NATIVE, equal } from '../src/engine/core.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222';
const quote = '0x3333333333333333333333333333333333333333';
const other = '0x4444444444444444444444444444444444444444';
const pad = GANG_PADS[0];
const transferAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const log = (asset, from, to, n) => ({ address: asset, topics: encodeEventTopics({ abi: transferAbi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [n]) });
const cfg = { waitSeconds: 1, slippageBps: 100, swapSlippageBps: 100 };
const session = { wallet, settings: { devMode: { enabled: true } } };
const market = { platform: 'gang', version: 'v2', input: token, token, market: pad.address };

function fixture(side = 'buy', eligible = true) {
  const curve = [wallet, quote, side === 'sell' ? 100000n : 0n, side === 'sell' ? units('20000000') : 0n, 15000000n, 5000000n, false, false, other, other];
  const held = units('1000000');
  const data = { id: 'offline', intent: { side, token, amount: side === 'buy' ? '0.001' : '50%' }, steps: {}, values: {}, status: 'RUNNING' };
  const journal = { data, save() {}, value(k, v) { if (v !== undefined) data.values[k] = v; return data.values[k]; } };
  const receipts = new Map(), transactions = new Map(), orders = new Map();
  const calls = [], buys = [];
  let preview, nonce = 0, allowance = 0n;
  const hash = () => '0x' + (++nonce).toString(16).padStart(64, '0');
  const client = {
    async readContract(r) {
      switch (r.functionName) {
        case 'curves': return curve;
        case 'isAgent': return eligible;
        case 'walletRoom': return units('10000000');
        case 'decimals': return equal(r.address, quote) ? 6 : 18;
        case 'symbol': return equal(r.address, quote) ? 'Q6' : 'TOK';
        case 'balanceOf': return equal(r.address, token) ? held : 999999999n; // existing quote must NOT expand the buy
        case 'allowance': return allowance;
        default: throw new Error('unexpected read ' + r.functionName);
      }
    },
    async waitForTransactionReceipt({ hash }) { assert(receipts.has(hash)); return receipts.get(hash); },
    async getTransaction({ hash }) { return transactions.get(hash); },
  };
  const baw = { async call(args) {
    calls.push(args);
    const opt = flag => args[args.indexOf(flag) + 1];
    if (args[0] === 'contract-call' && args[1] === 'preview') {
      preview = { to: opt('--to'), input: opt('--inputData'), value: BigInt(opt('--value')), from: wallet };
      return { requestId: 'req-' + calls.length, requireConfirmation: false };
    }
    if (args[0] === 'contract-call' && args[1] === 'execute') {
      const h = hash(); let logs = [];
      if (equal(preview.to, quote) || equal(preview.to, token)) {
        const decoded = decodeFunctionData({ abi: ERC20, data: preview.input });
        assert.equal(decoded.functionName, 'approve'); allowance = decoded.args[1];
      } else {
        const decoded = decodeFunctionData({ abi: pad.abi, data: preview.input });
        if (decoded.functionName === 'buy') {
          const [, gross] = decoded.args; buys.push(gross);
          const expected = gangBuy(curve, gross, units('10000000'));
          logs = [log(quote, wallet, pad.address, gross), log(quote, pad.address, wallet, expected.refund), log(token, pad.address, wallet, expected.amount)];
        } else {
          assert.equal(decoded.functionName, 'sell'); assert.equal(decoded.args[1], held / 2n);
          logs = [log(token, wallet, pad.address, held / 2n), log(quote, pad.address, wallet, 1234n)];
        }
      }
      transactions.set(h, preview); receipts.set(h, { status: 'success', transactionHash: h, logs });
      return { status: 'BROADCASTED', txHash: h, orderId: h };
    }
    if (args[0] === 'market-order' && args[1] === 'quote') return { toCoinAmount: '2' };
    if (args[0] === 'market-order' && args[1] === 'swap') {
      const from = opt('--fromToken'), to = opt('--toToken'), qty = opt('--fromTokenQty');
      const h = hash(), id = 'order-' + nonce;
      if (equal(from, NATIVE)) assert.equal(qty, '0.001');
      const logs = equal(to, quote) ? [log(quote, other, wallet, 2000000n)] : [];
      receipts.set(h, { status: 'success', transactionHash: h, logs });
      transactions.set(h, { from: wallet, to: other, input: '0x', value: equal(from, NATIVE) ? units(qty) : 0n });
      orders.set(id, { orderId: id, status: 'FINISHED', fromToken: from, toToken: to, txHash: h, toTokenActualQty: equal(to, quote) ? '2' : '0.0009' });
      return { orderId: id };
    }
    if (args[0] === 'market-order' && args[1] === 'list') return { list: [orders.get(opt('--orderId'))] };
    throw new Error('unexpected BAW ' + args.join(' '));
  } };
  return { client, baw, journal, calls, buys };
}

test('Gang six-decimal quote: BNB budget → receipt funding → approval → capped buy → refund back to BNB', async () => {
  const f = fixture();
  const result = await runTrade(f.client, cfg, market, session, f.journal, f.baw);
  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(f.buys, [2000000n]); // 2 Q6, never parseEther(2), never existing holdings
  assert.equal(f.journal.data.values['fund-buy'].amountRaw, '2000000');
  assert(f.calls.some(x => x[0] === 'market-order' && x[1] === 'swap' && x.includes(quote) && x.includes(NATIVE)));
  assert.equal(f.calls.filter(x => x[0] === 'contract-call' && x[1] === 'execute').length, 2); // approve + buy
  assert.equal(f.calls.filter(x => x[0] === 'market-order' && x[1] === 'swap').length, 2); // funding + unused quote refund
});
test('Gang sell percent: exact token approval → sell → only received quote converted to BNB', async () => {
  const f = fixture('sell');
  const result = await runTrade(f.client, cfg, market, session, f.journal, f.baw);
  assert.equal(result.status, 'SUCCESS');
  const swap = f.calls.find(x => x[0] === 'market-order' && x[1] === 'swap');
  assert.equal(swap[swap.indexOf('--fromTokenQty') + 1], '0.001234');
  assert.equal(swap[swap.indexOf('--toToken') + 1], NATIVE);
});
test('identity failure happens before any funding swap/approval', async () => {
  const f = fixture('buy', false);
  await assert.rejects(runTrade(f.client, cfg, market, session, f.journal, f.baw), { code: 'BUY_NOT_ALLOWED' });
  assert.equal(f.calls.length, 0);
});
test('Developer Mode failure happens before any funding swap', async () => {
  const f = fixture();
  await assert.rejects(runTrade(f.client, cfg, market, { wallet, settings: { devMode: { enabled: false } } }, f.journal, f.baw), { code: 'DEVELOPER_MODE_REQUIRED' });
  assert.equal(f.calls.length, 0);
});
