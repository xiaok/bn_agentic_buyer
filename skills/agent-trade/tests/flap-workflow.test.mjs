import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData, encodeAbiParameters, parseAbiParameters, encodeEventTopics, parseAbi} from 'viem';
const {runTrade} = await import('../scripts/trade.mjs');
const {FLAP, FLAP_ORDINARY, FLAP_PORTAL, FLAP_MAIN, ERC20} = await import('../scripts/adapters.mjs');
const {ZERO} = await import('../scripts/core.mjs');
const wallet = '0x1111111111111111111111111111111111111111';
const marketAddress = '0x2222222222222222222222222222222222222222';
const probe = '0x3333333333333333333333333333333333333333';
const token = '0x4444444444444444444444444444444444444444';
const market = {platform:'flap',version:'agent-curve',input:marketAddress,market:marketAddress,probe};
const session = {wallet,settings:{devMode:{enabled:true}}};
const cfg = {slippageBps:100,swapSlippageBps:100,waitSeconds:1};
const transfer = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const log = (from,to,amount) => ({address:token,topics:encodeEventTopics({abi:transfer,eventName:'Transfer',args:{from,to}}),data:encodeAbiParameters(parseAbiParameters('uint256'),[amount])});
const revert = text => {throw {data:'0x08c379a0'+encodeAbiParameters(parseAbiParameters('string'),[text+';END']).slice(2)};};
function harness({launched=true,pendingKind='claim',dex=false}={}) {
  let shares=launched?50n:100n, held=launched?7_000_000n:0n, allowance=0n, approved=false, id=0;
  const calls=[], requests=new Map(), executions=[];
  const data={id:'flap-mock',intent:{side:'sell',token:marketAddress,amount:'all'},steps:{},values:{}};
  const journal={data,save(){},value(key,value){if(value!==undefined)data.values[key]=value;return data.values[key]}};
  function result(request, kind) {
    const hash='0x'+String(++id).padStart(64,'0');
    const value=BigInt(request[request.indexOf('--value')+1]);
    const to=request[request.indexOf('--to')+1],input=request[request.indexOf('--inputData')+1];
    let logs=[];
    if(kind==='claim'){shares=0n;held+=3_000_000n;logs=[log(ZERO,wallet,3_000_000n)]}
    if(kind==='approve')allowance=10_000_000n;
    if(kind==='swapExactInput'){logs=[log(wallet,FLAP_MAIN,held)];held=0n}
    requests.set(hash,{from:wallet,to,input,value,logs});
    return hash;
  }
  function kindOf(request){const to=request[request.indexOf('--to')+1],input=request[request.indexOf('--inputData')+1];return decodeFunctionData({abi:to.toLowerCase()===FLAP_PORTAL.toLowerCase()?FLAP.portal:to.toLowerCase()===FLAP_MAIN.toLowerCase()?FLAP_ORDINARY:ERC20,data:input}).functionName}
  const client={
    async call(request){
      if(request.to===FLAP_MAIN){const q=decodeFunctionData({abi:FLAP_ORDINARY,data:request.data});calls.push(q);return {data:encodeAbiParameters(parseAbiParameters('uint256'),[1_000_000n])}}
      const {functionName}=decodeFunctionData({abi:FLAP.probe,data:request.data});
      if(functionName==='assetProbe')return revert(`MARKET=${marketAddress};QUOTE=${ZERO};DECIMALS=18`);
      if(functionName==='claimableProbe')return revert('STATE=READY;CLAIM_RAW=3000000;PHASE=3');
      if(functionName==='positionProbe')return revert(`HELD_SHARES=${shares};SELL_OK=1;PHASE=1`);
      if(functionName==='sellPlanCustomProbe')return revert('SHARES=100;MIN_WEI=1;BLOCK=1');
      throw Error('unexpected '+functionName);
    },
    async readContract({functionName}){if(functionName==='phase')return launched?3:1;if(functionName==='token')return launched?token:ZERO;if(functionName==='getTokenV8Safe')return {status:dex?4:1,quoteTokenAddress:ZERO,nativeToQuoteSwapEnabled:false};if(functionName==='sharesOf')return shares;if(functionName==='decimals')return 6;if(functionName==='symbol')return 'SIX';if(functionName==='balanceOf')return held;if(functionName==='allowance')return allowance;throw Error('unexpected read '+functionName)},
    async getBlockNumber(){return 1n},async getCode(){return '0x1234'},
    async waitForTransactionReceipt({hash}){return {status:'success',transactionHash:hash,logs:requests.get(hash).logs}},
    async getTransaction({hash}){return requests.get(hash)}
  };
  const pending=new Map();
  const baw={async call(args){calls.push(args);if(args[1]==='preview'){const requestId='r'+calls.length;pending.set(requestId,args);return {requestId,requireConfirmation:true}}if(args[1]==='execute'){const request=pending.get(args[3]),kind=kindOf(request);executions.push({kind,request});if(kind===pendingKind&&!approved){pending.set('order',request);return {status:'PENDING_CONFIRMATION',orderId:'own-order'}}return {status:'BROADCASTED',txHash:result(request,kind),orderId:'order-'+executions.length}}if(args[1]==='tx-history'){if(!approved)return {items:[]};const request=pending.get('order');return {items:[{orderId:'own-order',txHash:result(request,kindOf(request))}]}}throw Error('unexpected BAW '+args)}};
  return {client,baw,journal,calls,executions,approve(){approved=true},migrate(){dex=true}};
}
test('Flap launched sell all resumes claim once and sells six-decimal actual token holdings',async()=>{
  const h=harness();
  await assert.rejects(runTrade(h.client,cfg,market,session,h.journal,h.baw),{code:'PENDING_CONFIRMATION'});
  assert.deepEqual(h.executions.map(x=>x.kind),['claim']);
  h.approve();
  const out=await runTrade(h.client,cfg,market,session,h.journal,h.baw);
  assert.equal(out.status,'SUCCESS');
  assert.deepEqual(h.executions.map(x=>x.kind),['claim','approve','swapExactInput']);
  assert.equal(h.journal.data.values.sellAmountRaw,'10000000');
  const trade=h.executions.at(-1).request;
  const decoded=decodeFunctionData({abi:FLAP_ORDINARY,data:trade[trade.indexOf('--inputData')+1]});
  assert.equal(decoded.args[0].inputAmount,10_000_000n);
  assert.equal(out.actualTokenDeltaRaw,'-10000000');
});
test('Flap internal sell all uses 10000 share bps without ERC20 approval',async()=>{
  const h=harness({launched:false,pendingKind:'none'});
  const out=await runTrade(h.client,cfg,market,session,h.journal,h.baw);
  assert.equal(out.status,'SUCCESS');assert.deepEqual(h.executions.map(x=>x.kind),['sellBps']);
  const request=h.executions[0].request;
  const decoded=decodeFunctionData({abi:FLAP.portal,data:request[request.indexOf('--inputData')+1]});
  assert.equal(decoded.args[1],10_000n);assert.equal(out.actualTokenDeltaRaw,undefined);
});
test('Flap ordinary approval pending resumes approval once and trade once',async()=>{
  const h=harness({pendingKind:'approve'});
  await assert.rejects(runTrade(h.client,cfg,market,session,h.journal,h.baw),{code:'PENDING_CONFIRMATION'});
  assert.deepEqual(h.executions.map(x=>x.kind),['claim','approve']);h.approve();
  const out=await runTrade(h.client,cfg,market,session,h.journal,h.baw);
  assert.equal(out.status,'SUCCESS');assert.deepEqual(h.executions.map(x=>x.kind),['claim','approve','swapExactInput']);
});
test('migration before pending claim resume confirms original claim then stops remaining plan',async()=>{
  const h=harness();
  await assert.rejects(runTrade(h.client,cfg,market,session,h.journal,h.baw),{code:'PENDING_CONFIRMATION'});
  h.approve();h.migrate();
  for(let i=0;i<2;i++) await assert.rejects(runTrade(h.client,cfg,market,session,h.journal,h.baw),{code:'MARKET_CHANGED'});
  assert.equal(h.journal.data.steps.claim.status,'CONFIRMED');
  assert.equal(h.calls.filter(x=>Array.isArray(x)&&x[1]==='tx-history').length,1);
  assert.equal(h.journal.data.steps.claim.executeAttempted,true);
  assert.deepEqual(h.executions.map(x=>x.kind),['claim']);
  assert(h.journal.data.steps.claim.txHash);
});
