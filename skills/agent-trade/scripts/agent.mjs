#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Baw, Journal, address, bps, units, checkedClient, emit, fail, loadConfig, validateConfig, stateDir, atomicWrite, walletLock, equal } from './core.mjs';
import { detect, state } from './adapters.mjs';
import { dryRun, runTrade } from './trade.mjs';
import { Executor } from './executor.mjs';

const HELP = `agent-trade — Four Agent ID / Flap Agent Curve / Gang · BSC

agent buy <address> [BNB]          默认 0.001 BNB，真实执行
agent sell <address> <50%|all|qty> 卖出并结算 BNB；Flap 内盘用百分比
agent inspect <address>           只读识别平台、阶段
agent buy <address> [BNB] --dry-run --from <address> 只读构造，不试买、不广播
agent connect                    复用/连接现有 baw
agent status <operationId>       查状态，不产生新交易
agent resume <operationId>       继续原操作，不重复已提交步骤
agent config                     查看参数
agent config set buyAmountBnb 0.001
agent config set slippageBps 100

可选：--slippage-bps N --swap-slippage-bps N --rpc URL
依赖 Node >=22、pnpm install、已有 baw >=1.12.0。
真实下单跳过本地额外试买模拟；BAW 必需的 preview/execute 自动完成。`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean', short: 'h' }, 'dry-run': { type: 'boolean' }, from: { type: 'string' },
    'slippage-bps': { type: 'string' }, 'swap-slippage-bps': { type: 'string' }, rpc: { type: 'string' },
  } });
  const [command, a, b, c] = positionals;
  if (values.help || !command) { process.stdout.write(HELP + '\n'); return; }
  let cfg = loadConfig();
  if (values.rpc) cfg.rpcUrl = values.rpc;
  if (values['slippage-bps'] !== undefined) cfg.slippageBps = bps(values['slippage-bps']);
  if (values['swap-slippage-bps'] !== undefined) cfg.swapSlippageBps = bps(values['swap-slippage-bps']);
  validateConfig(cfg);
  if (command === 'config') {
    if (!a) { emit({ status: 'CONFIG', config: cfg, configFile: join(stateDir(), 'config.json') }); return; }
    if (a !== 'set' || !['buyAmountBnb', 'slippageBps', 'swapSlippageBps', 'rpcUrl', 'waitSeconds', 'bawBin'].includes(b) || c === undefined || positionals.length !== 4) throw fail('INVALID_CONFIG_COMMAND', '使用 agent config set <key> <value>');
    let user = {}; try { user = JSON.parse(readFileSync(join(stateDir(), 'config.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    user[b] = ['slippageBps', 'swapSlippageBps', 'waitSeconds'].includes(b) ? Number(c) : c;
    validateConfig({ ...cfg, ...user }); atomicWrite(join(stateDir(), 'config.json'), user);
    emit({ status: 'CONFIG_SAVED', key: b, value: user[b] }); return;
  }
  const baw = new Baw(cfg);
  if (command === 'connect') { await baw.connect(); const session = await baw.session({ connect: false }); emit({ status: 'CONNECTED', wallet: session.wallet }); return; }
  if (command === 'status' || command === 'resume') {
    if (positionals.length !== 2) throw fail('INVALID_ARGUMENTS', '需要 operationId');
    const journal = Journal.load(a);
    if (journal.data.status === 'SUCCESS') { emit(journal.data.result); return; }
    if (command === 'resume' && ['FAILED', 'BLOCKED'].includes(journal.data.status)) throw fail('OPERATION_STOPPED', '操作已停止，未自动重试；查看 status 中已完成的步骤和原始错误');
    cfg = journal.data.cfg; validateConfig(cfg);
    const currentBaw = new Baw(cfg);
    const [client, session] = await Promise.all([checkedClient(cfg), currentBaw.session({ connect: false })]);
    if (!equal(session.wallet, journal.data.wallet)) throw fail('WALLET_CHANGED', '当前钱包与原操作钱包不一致');
    const unlock = walletLock(session.wallet, journal.data.id);
    try {
      if (command === 'status') {
        const executor = new Executor(client, cfg, session.wallet, session.settings, journal, currentBaw);
        for (const step of Object.values(journal.data.steps)) {
          if (step.kind === 'contract' && step.executeAttempted && step.status !== 'CONFIRMED' && step.status !== 'FAILED') {
            try { await executor.refreshPending(step); } catch (e) { journal.data.lastStatusError = { code: e.code, message: e.message, data: e.data }; }
          }
          if (step.kind === 'swap' && step.executeAttempted && step.status !== 'CONFIRMED' && step.status !== 'FAILED') {
            try { await executor.swap(step.name, step.fromToken, step.toToken, BigInt(step.rawAmount)); } catch (e) { journal.data.lastStatusError = { code: e.code, message: e.message, data: e.data }; }
          }
        }
        journal.save(); emit({ status: journal.data.status, operationId: a,
          steps: Object.values(journal.data.steps).map(s => ({ name: s.name, kind: s.kind, status: s.status, txHash: s.txHash, orderId: s.orderId, requestId: s.requestId })),
          error: journal.data.lastError, statusError: journal.data.lastStatusError, next: 'agent resume ' + a }); return;
      }
      journal.data.status = 'RUNNING'; journal.save();
      const market = journal.value('detectedMarket') || await detect(client, cfg, journal.data.intent.token);
      try { emit(await runTrade(client, cfg, market, session, journal, currentBaw)); }
      catch (e) { recordError(journal, e); throw e; }
    } finally { unlock(); }
    return;
  }
  if (!['buy', 'sell', 'inspect'].includes(command)) throw fail('UNKNOWN_COMMAND', HELP);
  if (!a || positionals.length > (command === 'inspect' ? 2 : 3)) throw fail('INVALID_ARGUMENTS', '参数数量不正确');
  const token = address(a);
  if (values.from && !values['dry-run'] && command !== 'inspect') throw fail('FROM_ONLY_READONLY', '--from 仅允许用于只读模式；真实交易必须使用已连接钱包');
  const amount = b ?? (command === 'buy' ? cfg.buyAmountBnb : undefined);
  if (command === 'buy') units(amount);
  if (command === 'sell' && !amount) throw fail('SELL_AMOUNT_REQUIRED', '请指定 50%、all 或明确数量');
  if (command === 'sell' && amount !== 'all') { if (amount.endsWith('%')) { if (units(amount.slice(0, -1), 2) > 10000n) throw fail('INVALID_PERCENT', '比例不能超过 100%'); } else units(amount); }
  const client = await checkedClient(cfg);
  if (command === 'inspect') { const market = await detect(client, cfg, token); const { abi, ...view } = await state(client, cfg, market); emit({ status: 'INSPECTED', market: view }); return; }
  const intent = { side: command, token, amount };
  if (values['dry-run']) {
    const wallet = values.from ? address(values.from) : (await baw.session({ connect: false })).wallet;
    const market = await detect(client, cfg, token);
    emit(await dryRun(client, cfg, market, wallet, intent)); return;
  }
  const [market, session] = await Promise.all([detect(client, cfg, token), baw.session()]);
  const unlock = walletLock(session.wallet);
  let journal;
  try {
    journal = Journal.create(intent, session.wallet, cfg);
    const result = await runTrade(client, cfg, market, session, journal, baw);
    emit(result);
  } catch (e) { if (journal) recordError(journal, e); throw e; }
  finally { unlock(); }
}
function recordError(journal, error) {
  const pending = ['PENDING', 'PENDING_CONFIRMATION', 'SUBMISSION_UNKNOWN'].includes(error.code);
  // Any unresolved submission blocks a new order, even when a later status lookup
  // fails with a network error. Never let a generic error turn it into a retry.
  const unresolved = Object.values(journal.data.steps).some(s => s.executeAttempted && !['CONFIRMED', 'FAILED'].includes(s.status));
  journal.data.status = pending || unresolved ? (error.code === 'SUBMISSION_UNKNOWN' ? 'SUBMISSION_UNKNOWN' : 'PENDING') : 'FAILED';
  journal.data.lastError = { code: error.code || 'ERROR', message: error.shortMessage || error.message, data: error.data };
  error.data = { ...error.data, operationId: journal.data.id, operationStatus: journal.data.status };
  journal.save();
}
main().catch(error => { emit({ status: error.data?.operationStatus || 'ERROR', code: error.code || 'ERROR', message: error.shortMessage || error.message, ...error.data }); process.exitCode = 1; });
