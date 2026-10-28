import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters } from 'viem';
import { detectGang, state, buildGang, GANG_PADS, ERC20, WRAPPED, gangBuy } from '../src/engine/adapters.mjs';
import { GANG_MERGED_PAD as PAD, GANG_ROUTER as ROUTER, GANG_MERGED_ABI as ABI, GANG_ROUTER_ABI, GANG_S_ABI } from '../src/engine/vendor/gang-merged.mjs';
import { runTrade } from '../src/engine/trade.mjs';
import { units, WBNB, ZERO, equal } from '../src/engine/core.mjs';

const wallet = '0x1111111111111111111111111111111111111111';
const token = '0x378afee1ce6c88f0fdc568518140b9a0ab794da5';
const other = '0x2222222222222222222222222222222222222222';
const market = { platform: 'gang', version: 'merged-v3', input: token, token, market: PAD };
const cfg = { waitSeconds: 1, slippageBps: 100, swapSlippageBps: 100 };
const session = { wallet, settings: { devMode: { enabled: true } } };
const transfer = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const log = (asset, from, to, amount) => ({ address: asset, topics: encodeEventTopics({ abi: transfer, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [amount]) });

function fixture({ side = 'buy', room = units('10000000'), pendingRefund = false, quote = WBNB, gate = true, listed = true, kind = 1 } = {}) {
  const virtualTokens = 1066666666666666666666666667n;
  const sold = virtualTokens - (units('5') * virtualTokens + units('6') - 1n) / units('6');
  const curve = [wallet, quote, units('1'), sold, units('15'), units('5'), false, 200, 200, 3300, ZERO, ZERO];
  const data = { id: 'merged-test', status: 'RUNNING', intent: { side, token, amount: side === 'buy' ? '0.001' : '50%' }, steps: {}, values: {} };
  const journal = { data, async save() {}, value(k, v) { if (v !== undefined) data.values[k] = v; return data.values[k]; } };
  const reads = [], calls = [], executed = [], receipts = new Map(), transactions = new Map();
  let current, allowance = 0n, nonce = 0, refundApproved = !pendingRefund, pending;
  const client = {
    async readContract(r) {
      reads.push(r);
      switch (r.functionName) {
        case 'curves': {
          if (equal(r.address, PAD)) return curve;
          const n = r.abi.find(x => x.name === 'curves').outputs.length;
          return Array.from({ length: n }, (_, i) => r.abi.find(x => x.name === 'curves').outputs[i].type === 'address' ? ZERO : r.abi.find(x => x.name === 'curves').outputs[i].type === 'bool' ? false : 0n);
        }
        case 'kindOf': return kind;
        case 'launchpad': return PAD;
        case 'pad': return PAD;
        case 'wbnb': return WBNB;
        case 'routers': return listed;
        case 'agentGateEnabled': return gate;
        case 'PROTOCOL_FEE_BPS': return 100n;
        case 'VIRTUAL_TOKEN': return 1066666666666666666666666667n;
        case 'isAgent': return true;
        case 'walletRoom': return room;
        case 'decimals': return 18;
        case 'symbol': return 'BOLT';
        case 'balanceOf': return units('1000000');
        case 'allowance': return allowance;
        default: throw Error('Unexpected read ' + r.functionName);
      }
    },
    async getBlock() { return { timestamp: 1800000000n }; },
    async waitForTransactionReceipt({ hash }) { return receipts.get(hash); },
    async getTransaction({ hash }) { return transactions.get(hash); },
  };
  const materialize = (wire, decoded) => {
    const hash = '0x' + String(++nonce).padStart(64,'0'); let logs = [];
    if (decoded.functionName === 'v3BuyBNB') {
      const q = gangBuy(curve, wire.value, room);
      logs = [log(token, PAD, wallet, q.amount)]; if (q.refund) logs.push(log(WBNB, PAD, wallet, q.refund));
    } else if (decoded.functionName === 'sell') {
      logs = [log(token, wallet, PAD, units('500000')), log(WBNB, PAD, wallet, 12345n)];
    } else if (decoded.functionName === 'approve') allowance = decoded.args[1];
    else if (decoded.functionName !== 'withdraw') throw Error('Unexpected execution ' + decoded.functionName);
    receipts.set(hash, { status: 'success', transactionHash: hash, logs }); transactions.set(hash, { from: wallet, to: wire.to, input: wire.data, value: wire.value }); return hash;
  };
  const baw = { async call(args) {
    calls.push(args); const opt = flag => args[args.indexOf(flag)+1];
    if (args[1] === 'preview') {
      current = { to: opt('--to'), data: opt('--inputData'), value: BigInt(opt('--value')) };
      return { requestId: 'request-'+calls.length, requireConfirmation: false };
    }
    if (args[1] === 'execute') {
      const wire = { ...current }, abi = equal(wire.to,ROUTER) ? GANG_ROUTER_ABI : equal(wire.to,WBNB) ? WRAPPED : equal(wire.to,token) ? ERC20 : ABI;
      const decoded = decodeFunctionData({ abi, data: wire.data }); executed.push({ wire, decoded });
      if (pendingRefund && decoded.functionName === 'withdraw' && !refundApproved) { pending = { wire, decoded }; return { status: 'PENDING_CONFIRMATION', orderId: 'refund-order' }; }
      return { status: 'BROADCASTED', txHash: materialize(wire,decoded) };
    }
    if (args[1] === 'tx-history') return { list: refundApproved ? [{ binanceTxId: 'refund-order', txHash: materialize(pending.wire,pending.decoded) }] : [] };
    throw Error('Unexpected wallet API ' + args.join(' '));
  } };
  return { client, journal, baw, reads, calls, executed, curve, approveRefund() { refundApproved = true; } };
}

test('new merged pad detects BOLT and distinguishes fair mint without using a V2 ABI', async () => {
  const f = fixture(); assert.deepEqual(await detectGang(f.client,token), market);
  const fair = fixture({ kind: 2 }); fair.curve[0] = ZERO;
  const m = await detectGang(fair.client,token); assert.equal(m.version,'merged-fair');
  await assert.rejects(state(fair.client,cfg,m), { code: 'UNSUPPORTED_GANG_KIND' });
});
test('nine-word S curve decodes correctly and unregistered tokens do not become RPC errors', async () => {
  const raw = encodeAbiParameters(parseAbiParameters('address,address,uint128,uint128,uint128,uint128,bool,address,address'), [ZERO,ZERO,0n,0n,0n,0n,false,ZERO,ZERO]);
  assert.equal(decodeFunctionResult({abi:GANG_S_ABI,functionName:'curves',data:raw}).length,9);
  const f = fixture({kind:0});f.curve[0]=ZERO;assert.equal(await detectGang(f.client,token),null);
});
test('router binding and curve fee changes block preparation before any wallet calls', async () => {
  for (const field of ['pad','wbnb','PROTOCOL_FEE_BPS','VIRTUAL_TOKEN']) {
    const f=fixture(),read=f.client.readContract;
    f.client.readContract=async r=>r.functionName===field ? field==='pad'||field==='wbnb'?other:101n : read(r);
    await assert.rejects(state(f.client,cfg,market), { code: field==='pad'||field==='wbnb'?'BINDING_MISMATCH':'UNSUPPORTED_CURVE' });assert.equal(f.calls.length,0);
  }
});
test('native merged buy uses one payable Router trade with no preliminary wrap or approval', async () => {
  const f=fixture();const out=await runTrade(f.client,cfg,market,session,f.journal,f.baw);
  assert.equal(out.status,'SUCCESS');assert.deepEqual(f.executed.map(x=>x.decoded.functionName),['v3BuyBNB']);
  assert.equal(f.executed[0].wire.to,ROUTER);assert.equal(f.executed[0].wire.value,units('0.001'));
  assert.equal(f.executed[0].decoded.args[2],1800000300n);assert(!f.journal.data.values['fund-buy']);
});
test('cap refund unwraps only received WBNB and resumes an App-pending unwrap without a second buy', async () => {
  const f=fixture({room:units('1'),pendingRefund:true});
  await assert.rejects(runTrade(f.client,cfg,market,session,f.journal,f.baw),{code:'PENDING_CONFIRMATION'});
  const refund=gangBuy(f.curve,units('0.001'),units('1')).refund;
  assert(refund>0n);assert.equal(f.executed[1].decoded.args[0],refund);
  f.approveRefund();const out=await runTrade(f.client,cfg,market,session,f.journal,f.baw);
  assert.equal(out.status,'SUCCESS');assert.deepEqual(f.executed.map(x=>x.decoded.functionName),['v3BuyBNB','withdraw']);
});
test('merged sell approves the Pad, sells the requested fraction and unwraps only proceeds', async () => {
  const f=fixture({side:'sell'});const out=await runTrade(f.client,cfg,market,session,f.journal,f.baw);
  assert.equal(out.status,'SUCCESS');assert.deepEqual(f.executed.map(x=>x.decoded.functionName),['approve','sell','withdraw']);
  assert.equal(f.executed[0].decoded.args[0],PAD);assert.equal(f.executed[0].decoded.args[1],units('500000'));
  assert.equal(f.executed[1].wire.to,PAD);assert.equal(f.executed[2].decoded.args[0],12345n);
});
test('non-WBNB quotes retain exact quote approval, and disabled native route never emits payable buy', async () => {
  const f=fixture({quote:other}),s=await state(f.client,cfg,market);
  const plan=await buildGang(f.client,s,wallet,'buy',123n,100);
  assert.equal(plan.tx.to,PAD);assert.equal(plan.tx.value,0n);assert.equal(plan.approval.token,other);assert.equal(plan.approval.spender,PAD);assert.equal(plan.approval.amount,123n);
  const disabled=fixture({listed:false}),s2=await state(disabled.client,cfg,market);
  assert.equal(s2.nativeBuy,false);assert.equal((await buildGang(disabled.client,s2,wallet,'buy',units('0.001'),100)).tx.value,0n);
});
test('S split-fee rounding is calculated separately instead of rounding a combined percent', () => {
  const f=fixture(),combined=gangBuy(f.curve,199n,units('10000000')),split=gangBuy(f.curve,199n,units('10000000'),[50n,50n]);
  assert.equal(combined.fee,1n);assert.equal(split.fee,0n);assert(split.amount>combined.amount);
});
