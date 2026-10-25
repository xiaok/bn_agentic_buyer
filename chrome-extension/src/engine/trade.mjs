import { decodeEventLog, encodeFunctionData } from 'viem';
import { equal, fail, units, sellQuantity, NATIVE, ZERO, WBNB, erc20Delta, formatUnits, developerMode } from './core.mjs';
import { Executor, wireTx } from './executor.mjs';
import { state, four, buildFlap, buildGang, buildOrdinaryFlap, balance, metadata, read, ERC20, FLAP, FLAP_PORTAL, probe } from './adapters.mjs';

function open(s) { if (!['curve', 'dex', 'flap-curve'].includes(s.phase)) throw fail('MARKET_UNAVAILABLE', '市场当前不可交易', { phase: s.phase }); }
function payment(s) {
  if (s.phase === 'dex') return NATIVE;
  if (s.platform === 'four') return NATIVE; // Official Core builder includes native Zap when supported.
  if (s.platform === 'flap' && s.phase === 'flap-curve') {
    return s.flapState.nativeToQuoteSwapEnabled || equal(s.flapState.quoteTokenAddress, ZERO) ? NATIVE : s.flapState.quoteTokenAddress;
  }
  return s.quote;
}
export async function build(client, cfg, s, wallet, side, quantity, slip) {
  if (s.platform === 'four') {
    const meta = side === 'buy' ? { decimals: 18 } : await metadata(client, s.token);
    const q = await four(cfg, side === 'buy' ? 'quote-buy' : 'quote-sell', {
      token: s.token, wallet, amount: formatUnits(quantity, meta.decimals), slippageBps: slip,
      ...(side === 'sell' ? { receive: 'BNB' } : {}),
    });
    return { tx: q.tx, approval: q.approveTx ? { token: q.approveTx.to, spender: q.contracts.core,
      amount: side === 'buy' ? BigInt(q.pay.maxPayRaw) : BigInt(q.sell.amountRaw) } : null,
      estimate: q.estimate, outputToken: side === 'buy' ? s.token : NATIVE };
  }
  if (s.platform === 'gang') return buildGang(client, s, wallet, side, quantity, slip);
  if (s.phase === 'flap-curve') return buildOrdinaryFlap(client, s, wallet, side, quantity, slip);
  return buildFlap(client, s, wallet, side, quantity, slip);
}
export async function dryRun(client, cfg, market, wallet, intent) {
  const s = await state(client, cfg, market); open(s);
  if (s.phase === 'dex') return { status: 'DRY_RUN', platform: s.platform, phase: s.phase, route: 'baw-market-order',
    message: '外盘使用 BAW quote/swap；此只读模式未调用钱包后端', wallet, intent };
  if (intent.side === 'buy') {
    const asset = payment(s), budget = units(intent.amount);
    if (!equal(asset, NATIVE)) return { status: 'DRY_RUN', platform: s.platform, phase: s.phase, wallet,
      bnbBudget: intent.amount, steps: [equal(asset, WBNB) ? 'wrap BNB → WBNB' : 'BAW swap BNB → quote', 'approve quote', 'fresh inner quote', 'BAW preview → execute'], quoteToken: asset,
      message: '需要先实际兑换；只读模式不会兑换、授权或伪造后续模拟成功' };
    const plan = await build(client, cfg, s, wallet, 'buy', budget, cfg.slippageBps);
    return { status: 'DRY_RUN', platform: s.platform, phase: s.phase, wallet, bnbBudget: intent.amount,
      plan: { ...plan, tx: wireTx(plan.tx) }, localTradeSimulation: 'skipped', broadcast: false };
  }
  const meta = s.platform === 'flap' && s.phase === 'curve' ? { decimals: 18 } : await metadata(client, s.token);
  const quantity = s.platform === 'flap' && s.phase === 'curve' ? intent.amount
    : sellQuantity(intent.amount, await balance(client, s.token, wallet), meta.decimals);
  const plan = await build(client, cfg, s, wallet, 'sell', quantity, cfg.slippageBps);
  return { status: 'DRY_RUN', platform: s.platform, phase: s.phase, wallet, plan: { ...plan, tx: wireTx(plan.tx) }, localTradeSimulation: 'skipped', broadcast: false };
}
function actualTrades(s, receipt, wallet) {
  const abi = s.platform === 'flap' ? FLAP.market : s.abi;
  if (!abi) return [];
  const out = [];
  for (const log of receipt.logs || []) {
    if (!equal(log.address, s.market)) continue;
    try {
      const e = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (['VirtualTrade', 'Buy', 'Sell', 'Claimed'].includes(e.eventName)) {
        const actor = e.args.wallet || e.args.buyer || e.args.seller;
        if (actor && equal(actor, wallet)) out.push({ event: e.eventName, ...e.args });
      }
    } catch {}
  }
  return out;
}
export async function runTrade(client, cfg, market, session, journal, baw) {
  const executor = new Executor(client, cfg, session.wallet, session.settings, journal, baw);
  const { intent } = journal.data;
  // Submitted prep remains a real order even if the market migrates or Developer
  // Mode expires while the App is confirming. Reconcile it before new-plan gates.
  for (const step of Object.values(journal.data.steps)) {
    if (!step.executeAttempted || ['CONFIRMED', 'FAILED'].includes(step.status)) continue;
    if (step.kind === 'swap') await executor.swap(step.name, step.fromToken, step.toToken, BigInt(step.rawAmount));
    else await executor.refreshPending(step);
  }
  if (executor.done('trade')) return finish(client, cfg, market, executor, intent);
  const submittedTrade = journal.data.steps.trade;
  if (submittedTrade?.executeAttempted) {
    if (submittedTrade.kind === 'swap') await executor.swap('trade', submittedTrade.fromToken, submittedTrade.toToken, BigInt(submittedTrade.rawAmount));
    else await executor.refreshPending(submittedTrade);
    return finish(client, cfg, market, executor, intent);
  }
  let s = await state(client, cfg, market); open(s);
  if (s.phase !== 'dex') developerMode(session.settings);
  const initial = journal.value('initialMarket');
  if (initial && (initial.platform !== s.platform || initial.phase !== s.phase || !equal(initial.market, s.market))) {
    throw fail('MARKET_CHANGED', '市场阶段或合约已变化，停止原计划；已完成步骤保留在操作记录中', { initial, current: { platform: s.platform, phase: s.phase, market: s.market } });
  }
  if (!initial) journal.value('initialMarket', { platform: s.platform, phase: s.phase, market: s.market });
  journal.value('detectedMarket', { platform: market.platform, version: market.version, input: market.input, token: market.token, market: market.market, probe: market.probe });

  if (s.platform === 'flap' && s.phase !== 'curve' && intent.side === 'sell') {
    const shares = await read(client, s.market, FLAP.market, 'sharesOf', [session.wallet]);
    if (shares > 0n || journal.data.steps.claim?.executeAttempted) {
      if (!executor.done('claim')) {
        if (!journal.data.steps.claim?.executeAttempted) {
          const { probe } = await import('./adapters.mjs');
          const claim = await probe(client, s.probe, session.wallet, 'claimableProbe', [], ['STATE', 'CLAIM_RAW', 'PHASE']);
          if (claim.STATE !== 'READY' || claim.PHASE !== '3' || BigInt(claim.CLAIM_RAW) <= 0n) throw fail('CLAIM_NOT_READY', 'Flap 份额当前不能领取', { claim });
        }
        await executor.contract('claim', { to: FLAP_PORTAL, abi: FLAP.portal, functionName: 'claim', args: [s.market], value: 0n });
      }
      s = await state(client, cfg, market); open(s);
    }
  }

  if (s.phase === 'dex') {
    const tokenMeta = await metadata(client, s.token);
    const amount = intent.side === 'buy' ? units(intent.amount)
      : getSellAmount(journal, intent, await balance(client, s.token, session.wallet), tokenMeta.decimals);
    journal.value('tradeContext', { platform: s.platform, phase: s.phase, market: s.market, token: s.token, quote: NATIVE, side: intent.side, amountRaw: amount.toString() });
    await executor.swap('trade', intent.side === 'buy' ? NATIVE : s.token, intent.side === 'buy' ? s.token : NATIVE, amount);
    return finish(client, cfg, market, executor, intent);
  }

  let quantity;
  if (intent.side === 'buy') {
    // Reject missing identity/room before any wrap, swap or approval spends gas.
    if (s.platform === 'gang' && (!await read(client, s.market, s.abi, 'isAgent', [session.wallet])
        || await read(client, s.market, s.abi, 'walletRoom', [s.token, session.wallet]) <= 0n)) {
      throw fail('BUY_NOT_ALLOWED', 'Gang 买入身份或钱包持仓上限不满足');
    }
    if (s.platform === 'flap' && s.phase === 'curve') {
      const [status, capacity] = await Promise.all([
        probe(client, s.probe, session.wallet, 'actionStatusProbe', [], ['BUY_OK', 'PHASE']),
        probe(client, s.probe, session.wallet, 'buyCapacityProbe', [], ['ID', 'PHASE', 'ROOM_SHARES']),
      ]);
      if (status.PHASE !== '1' || status.BUY_OK !== '1' || capacity.ID !== '1' || capacity.PHASE !== '1' || BigInt(capacity.ROOM_SHARES) <= 0n) throw fail('BUY_NOT_ALLOWED', 'Flap 买入资格或钱包持仓上限不满足', { status, capacity });
    }
    const pay = payment(s);
    quantity = await executor.fund('fund-buy', pay, units(intent.amount));
    const fresh = await state(client, cfg, market); open(fresh);
    if (fresh.phase !== s.phase || !equal(payment(fresh), pay) || !equal(fresh.market, s.market)) throw fail('MARKET_CHANGED', '兑换后市场阶段/支付资产已变化，停止买入；不会再次花费 BNB');
    s = fresh;
    if (s.platform === 'flap' && s.phase === 'curve' && !equal(pay, NATIVE)) {
      await executor.approve('trade-approve', pay, s.market, quantity);
      const funding = await probe(client, s.probe, session.wallet, 'quoteFundingProbe', [quantity], ['BALANCE_OK', 'ALLOWANCE_OK', 'BLOCK']);
      if (funding.BALANCE_OK !== '1' || funding.ALLOWANCE_OK !== '1') throw fail('QUOTE_FUNDING_NOT_READY', 'Flap 报价币余额或 Market 授权不足', { funding });
    }
  } else if (s.platform === 'flap' && s.phase === 'curve') quantity = intent.amount;
  else {
    const tokenMeta = await metadata(client, s.token);
    quantity = getSellAmount(journal, intent, await balance(client, s.token, session.wallet), tokenMeta.decimals);
  }
  let plan = await build(client, cfg, s, session.wallet, intent.side, quantity, cfg.slippageBps);
  if (plan.approval) {
    const a = plan.approval;
    await executor.approve('trade-approve', a.token, a.spender, a.amount);
    const fresh = await state(client, cfg, market); open(fresh);
    if (fresh.phase !== s.phase || !equal(fresh.market, s.market)) throw fail('MARKET_CHANGED', '授权后市场阶段或合约变化，停止原计划');
    s = fresh;
    plan = await build(client, cfg, s, session.wallet, intent.side, quantity, cfg.slippageBps);
  }
  const outputToken = intent.side === 'buy' ? s.token : (plan.outputToken || (s.platform === 'four' ? NATIVE : s.quote));
  journal.value('tradeContext', { platform: s.platform, version: s.version, phase: s.phase, market: s.market, token: s.token,
    quote: s.quote, paymentToken: payment(s), outputToken, side: intent.side, amountRaw: typeof quantity === 'bigint' ? quantity.toString() : quantity,
    estimate: plan.estimate });
  await executor.contract('trade', plan.tx);
  return finish(client, cfg, market, executor, intent);
}
function getSellAmount(journal, intent, held, decimals) {
  const existing = journal.value('sellAmountRaw');
  const amount = existing ? BigInt(existing) : sellQuantity(intent.amount, held, decimals);
  if (amount <= 0n || amount > held) throw fail('INSUFFICIENT_BALANCE', '没有足够持仓执行原卖出数量');
  if (!existing) journal.value('sellAmountRaw', amount.toString());
  return amount;
}
async function finish(client, cfg, market, executor, intent) {
  const j = executor.journal;
  const context = j.value('tradeContext');
  if (!context) throw fail('INCOMPLETE_JOURNAL', '已提交交易缺少上下文，不能继续自动换币');
  const receipt = executor.receipt('trade');
  if (!receipt || !executor.done('trade')) throw fail('PENDING', '交易尚未确认', { operationId: j.data.id });
  let received = null;
  if (intent.side === 'sell' && context.phase !== 'dex' && context.outputToken && !equal(context.outputToken, NATIVE)) {
    received = erc20Delta(receipt, context.outputToken, executor.wallet);
    if (received <= 0n) throw fail('UNVERIFIED_PROCEEDS', '卖出已上链，但无法核对报价币到账；停止后续兑换', { txHash: receipt.transactionHash });
    await executor.toBnb('sell-to-bnb', context.outputToken, received);
  }
  if (intent.side === 'buy') {
    const funding = j.value('fund-buy');
    if (funding) {
      const delta = erc20Delta(receipt, funding.token, executor.wallet);
      const left = BigInt(funding.amountRaw) + delta;
      if (delta > 0n || left < 0n || left > BigInt(funding.amountRaw)) throw fail('UNVERIFIED_REFUND', '买入已上链，但无法核对报价币退款');
      if (left > 0n) await executor.toBnb('refund-to-bnb', funding.token, left);
    }
  }
  let decoded = [];
  if (context.platform === 'four' && context.phase !== 'dex') {
    try { const r = await four(cfg, 'receipt', { txHash: receipt.transactionHash }); decoded = r.trades || []; } catch {}
  } else {
    const s = { ...market, market: context.market, platform: context.platform };
    if (context.platform === 'gang') { const { GANG_PADS } = await import('./adapters.mjs'); s.abi = GANG_PADS.find(x => x.version === context.version)?.abi; }
    decoded = actualTrades(s, receipt, executor.wallet);
  }
  const hashes = Object.values(j.data.steps).filter(x => x.txHash).map(x => x.txHash);
  const result = { status: 'SUCCESS', operationId: j.data.id, side: intent.side, platform: context.platform,
    wallet: executor.wallet, inputAddress: intent.token, txHash: receipt.transactionHash, txHashes: hashes,
    bnbBudget: intent.side === 'buy' ? intent.amount : undefined, gasExtra: true, events: decoded,
    actualTokenDeltaRaw: context.token ? erc20Delta(receipt, context.token, executor.wallet).toString() : undefined,
    quoteReceivedRaw: received?.toString(), marketOrder: j.data.steps.trade.order,
    localTradeSimulation: 'skipped', message: intent.side === 'buy' ? '买入交易已确认' : '卖出及 BNB 结算步骤已确认' };
  j.data.status = 'SUCCESS'; j.data.result = result; await j.save(); return result;
}
