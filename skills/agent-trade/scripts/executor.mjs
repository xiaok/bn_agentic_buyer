import { encodeFunctionData, parseAbi } from 'viem';
import { Baw, developerMode, equal, fail, emit, sleep, json, NATIVE, WBNB, ZERO, erc20Delta, formatUnits, tx } from './core.mjs';
import { balance, metadata, read, ERC20, WRAPPED } from './adapters.mjs';

export function previewArgs(wallet, request) {
  return ['contract-call', 'preview', '--binanceChainId', '56', '--from', wallet, '--to', request.to,
    '--value', request.value.toString(), '--inputData', request.data];
}
export function wireTx(request) {
  return { to: request.to, value: BigInt(request.value || 0).toString(),
    data: request.data || request.inputData || encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }) };
}
export class Executor {
  constructor(client, cfg, wallet, settings, journal, baw = new Baw(cfg)) {
    Object.assign(this, { client, cfg, wallet, settings, journal, baw });
  }
  save() { this.journal.save(); }
  done(name) { return this.journal.data.steps[name]?.status === 'CONFIRMED'; }
  receipt(name) { return this.journal.data.steps[name]?.receipt; }
  async verifyReceipt(step, receipt) {
    if (receipt.status !== 'success') { step.status = 'FAILED'; this.save(); throw fail('ONCHAIN_REVERTED', '交易链上失败；不会重发', { txHash: step.txHash }); }
    const chainTx = await this.client.getTransaction({ hash: step.txHash });
    if (!equal(chainTx.from, this.wallet)) throw fail('RECEIPT_MISMATCH', '交易发送人不匹配');
    if (step.kind === 'contract' && (!equal(chainTx.to, step.request.to) || !equal(chainTx.input, step.request.data) || BigInt(chainTx.value) !== BigInt(step.request.value))) {
      throw fail('RECEIPT_MISMATCH', '交易接收方、calldata 或 value 不匹配，停止继续');
    }
    step.receipt = JSON.parse(json(receipt)); step.status = 'CONFIRMED'; this.save();
    return step.receipt;
  }
  async waitReceipt(step) {
    if (step.status === 'CONFIRMED') return step.receipt;
    if (!step.txHash) throw fail(step.status === 'SUBMITTING' ? 'SUBMISSION_UNKNOWN' : 'PENDING_CONFIRMATION', step.status === 'SUBMITTING' ? '提交结果未知，禁止重新提交；请查订单/交易记录' : '请在 Binance App 确认，然后运行 agent resume <operationId>', { operationId: this.journal.data.id, requestId: step.requestId, orderId: step.orderId });
    let receipt;
    try { receipt = await this.client.waitForTransactionReceipt({ hash: step.txHash, confirmations: 1, pollingInterval: 500, timeout: this.cfg.waitSeconds * 1000 }); }
    catch { throw fail('PENDING', '已提交，等待链上确认；请查询状态，禁止重发', { operationId: this.journal.data.id, txHash: step.txHash }); }
    return this.verifyReceipt(step, receipt);
  }
  async refreshPending(step) {
    if (!step.txHash && step.orderId) {
      const history = await this.baw.call(['wallet', 'tx-history', '--binanceChainId', '56']);
      const find = (o) => {
        if (!o || typeof o !== 'object') return null;
        if (String(o.orderId) === String(step.orderId) && /^0x[0-9a-fA-F]{64}$/.test(o.txHash || '')) return o.txHash;
        for (const value of Object.values(o)) { const match = find(value); if (match) return match; }
        return null;
      };
      const hash = find(history);
      if (hash) { step.txHash = hash; this.save(); }
    }
    return this.waitReceipt(step);
  }
  async contract(name, request) {
    let step = this.journal.data.steps[name];
    if (step?.status === 'CONFIRMED') return step.receipt;
    if (step?.executeAttempted) return this.refreshPending(step);
    if (step?.status === 'FAILED') throw fail('PREVIOUS_STEP_FAILED', '原交易步骤失败，不自动重发');
    developerMode(this.settings);
    const wire = wireTx(request);
    const preview = await this.baw.call(previewArgs(this.wallet, wire));
    if (!preview.requestId || !['boolean'].includes(typeof preview.requireConfirmation)) throw fail('INVALID_PREVIEW', 'BAW preview 返回不完整；未执行');
    if (preview.expiresAt && Number(preview.expiresAt) <= Date.now()) throw fail('PREVIEW_EXPIRED', 'BAW preview 已过期，未执行');
    step = { kind: 'contract', name, status: 'PREVIEWED', request: wire, requestId: preview.requestId,
      requireConfirmation: preview.requireConfirmation, risks: preview.risks, executeAttempted: false };
    this.journal.data.steps[name] = step; this.save();
    // Persist the attempt BEFORE the API call. Even a killed process can never
    // make a later invocation replay execute after an ambiguous response.
    step.executeAttempted = true; step.status = 'SUBMITTING'; this.save();
    let result;
    try { result = await this.baw.call(['contract-call', 'execute', '--requestId', preview.requestId]); }
    catch (e) {
      if (/^(351801|351802|351803|351804|351805|351806|351807|351818|351819|351820|351821)$/.test(String(e.data?.raw?.code || e.code))) { step.status = 'FAILED'; this.save(); throw e; }
      throw fail('SUBMISSION_UNKNOWN', '执行响应未知，保留原操作，禁止重发', { operationId: this.journal.data.id, requestId: step.requestId, originalError: e.message });
    }
    Object.assign(step, { orderId: result.orderId, txHash: result.txHash, status: result.status }); this.save();
    if (result.status === 'PENDING_CONFIRMATION') {
      emit({ event: 'APP_CONFIRMATION', operationId: this.journal.data.id, orderId: step.orderId, message: '请在 Binance App 确认；确认后运行 agent resume ' + this.journal.data.id });
    }
    if (!result.txHash && result.status !== 'PENDING_CONFIRMATION') throw fail('SUBMISSION_UNKNOWN', 'BAW 未返回可追踪交易哈希；禁止重发', { operationId: this.journal.data.id, orderId: step.orderId });
    return this.waitReceipt(step);
  }
  async approve(name, token, spender, amount) {
    if (this.done(name)) {
      const have = await read(this.client, token, ERC20, 'allowance', [this.wallet, spender]);
      if (have < amount) throw fail('ALLOWANCE_CHANGED', '已确认授权后 allowance 不足，停止而不自动加授权');
      return;
    }
    if (this.journal.data.steps[name]?.executeAttempted) {
      await this.refreshPending(this.journal.data.steps[name]);
      return this.approve(name, token, spender, amount);
    }
    const current = await read(this.client, token, ERC20, 'allowance', [this.wallet, spender]);
    if (current >= amount) return;
    // Zero-reset supports tokens that reject nonzero-to-nonzero approvals.
    if (current > 0n) await this.contract(name + '-reset', tx(token, ERC20, 'approve', [spender, 0n]));
    await this.contract(name, tx(token, ERC20, 'approve', [spender, amount]));
    const after = await read(this.client, token, ERC20, 'allowance', [this.wallet, spender]);
    if (after < amount) throw fail('APPROVAL_NOT_EFFECTIVE', '授权交易成功但 allowance 未生效');
  }
  async swap(name, fromToken, toToken, rawAmount) {
    const meta = await metadata(this.client, fromToken);
    const qty = formatUnits(rawAmount, meta.decimals);
    let step = this.journal.data.steps[name];
    if (step?.status === 'CONFIRMED') return step;
    if (step?.status === 'FAILED') throw fail('SWAP_FAILED', '原换币订单失败，不自动重下');
    if (!step) {
      const request = ['--fromTokenQty', qty, '--fromToken', fromToken, '--toToken', toToken, '--binanceChainId', '56', '--slippage', String(this.cfg.swapSlippageBps / 100)];
      const quote = await this.baw.call(['market-order', 'quote', ...request]);
      if (!quote.toCoinAmount || Number(quote.toCoinAmount) <= 0) throw fail('NO_SWAP_ROUTE', 'BAW 无可用兑换报价');
      step = { kind: 'swap', name, status: 'SUBMITTING', fromToken, toToken, rawAmount: rawAmount.toString(), quote, executeAttempted: true };
      this.journal.data.steps[name] = step; this.save();
      let submitted;
      try { submitted = await this.baw.call(['market-order', 'swap', ...request]); }
      catch (e) { throw fail('SUBMISSION_UNKNOWN', '换币提交结果未知，禁止重发', { operationId: this.journal.data.id, originalError: e.message }); }
      if (!submitted.orderId) throw fail('SUBMISSION_UNKNOWN', '换币未返回 orderId，禁止重发', { operationId: this.journal.data.id });
      step.orderId = submitted.orderId; step.status = 'PENDING'; this.save();
    }
    if (!step.orderId) throw fail('SUBMISSION_UNKNOWN', '换币提交结果未知，禁止重发', { operationId: this.journal.data.id });
    const deadline = Date.now() + this.cfg.waitSeconds * 1000;
    while (Date.now() < deadline) {
      const response = await this.baw.call(['market-order', 'list', '--orderId', step.orderId]);
      const order = response.list?.find(x => String(x.orderId) === String(step.orderId));
      if (order?.status === 'FAILED') { step.status = 'FAILED'; step.order = order; this.save(); throw fail('SWAP_FAILED', '换币订单失败', { order }); }
      if (order?.status === 'FINISHED') {
        if (!equal(order.fromToken, fromToken) || !equal(order.toToken, toToken)) throw fail('ORDER_MISMATCH', '兑换订单资产不匹配');
        if (!/^0x[0-9a-fA-F]{64}$/.test(order.txHash || '')) throw fail('PENDING', '换币状态已完成但尚无可验证交易哈希', { operationId: this.journal.data.id });
        step.order = order; step.txHash = order.txHash; this.save();
        await this.waitReceipt(step);
        return step;
      }
      await sleep(800);
    }
    throw fail('PENDING', '换币订单仍处理中，禁止重复下单', { operationId: this.journal.data.id, orderId: step.orderId });
  }
  async fund(name, quoteToken, bnbRaw) {
    const existing = this.journal.value(name);
    if (existing) return BigInt(existing.amountRaw);
    if (equal(quoteToken, NATIVE) || equal(quoteToken, ZERO)) return bnbRaw;
    let receipt;
    if (equal(quoteToken, WBNB)) {
      receipt = await this.contract(name + '-wrap', tx(WBNB, WRAPPED, 'deposit', [], bnbRaw));
      // WBNB's canonical Deposit log, not ERC20 Transfer, records a native wrap.
      const depositAbi = parseAbi(['event Deposit(address indexed dst,uint256 wad)']);
      const { decodeEventLog } = await import('viem');
      let amount = 0n;
      for (const log of receipt.logs) {
        if (!equal(log.address, WBNB)) continue;
        try { const e = decodeEventLog({ abi: depositAbi, data: log.data, topics: log.topics }); if (equal(e.args.dst, this.wallet)) amount += e.args.wad; } catch {}
      }
      if (amount !== bnbRaw) throw fail('UNVERIFIED_FUNDING', '无法核对 WBNB Deposit 到账数量');
      this.journal.value(name, { token: quoteToken, amountRaw: amount.toString() }); return amount;
    }
    const step = await this.swap(name + '-swap', NATIVE, quoteToken, bnbRaw);
    const amount = erc20Delta(step.receipt, quoteToken, this.wallet);
    if (amount <= 0n) throw fail('UNVERIFIED_FUNDING', '兑换 receipt 无法证明报价币实际到账，停止买入');
    this.journal.value(name, { token: quoteToken, amountRaw: amount.toString() }); return amount;
  }
  async toBnb(name, quoteToken, amount) {
    if (amount <= 0n || equal(quoteToken, NATIVE) || equal(quoteToken, ZERO)) return;
    if (equal(quoteToken, WBNB)) { await this.contract(name + '-unwrap', tx(WBNB, WRAPPED, 'withdraw', [amount])); return; }
    await this.swap(name + '-swap', quoteToken, NATIVE, amount);
  }
}
