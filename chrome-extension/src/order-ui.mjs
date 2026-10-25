export const isFinished = op => ['SUCCESS', 'FAILED', 'BLOCKED'].includes(op.status);
export const orderHash = op => op.result?.txHash || op.steps.find(step => step.name === 'trade' && step.txHash)?.txHash || [...op.steps].reverse().find(step => step.txHash)?.txHash;
const awaitingSettlement = op => op.status === 'PENDING' && op.intent.side === 'sell' && op.steps?.some(step => step.name === 'trade' && step.status === 'CONFIRMED');
export function orderLabel(op) {
  if (op.manualRelease) return '已手动解锁 · 结果未核实';
  if (awaitingSettlement(op)) return '卖出已确认／待结算';
  const side = op.intent.side === 'buy' ? '买入' : '卖出';
  return ({ SUCCESS: `${side}成功`, FAILED: `${side}失败`, BLOCKED: `${side}已停止`,
    RUNNING: `${side}中…`, PENDING: '等待确认／继续原订单', PENDING_CONFIRMATION: '等待 App 确认',
    SUBMISSION_UNKNOWN: '提交结果待核实，请勿重复下单' })[op.status] || op.status;
}
export function orderDetail(op) {
  if (op.manualRelease) return '本地锁已解除，旧订单不会继续执行。已提交交易仍可能成交；解锁不代表交易已撤销或失败。';
  if (op.status === 'SUCCESS') return '交易已在链上确认';
  if (awaitingSettlement(op)) return '卖出已在链上确认，后续 BNB 结算未完成。' + (op.error?.message || '请继续原订单处理剩余步骤。');
  return op.error?.message || op.progress?.message || op.progress?.phase || '正在处理，请勿重复点击';
}
export function canQuickSell(op, state) {
  return op.intent.side === 'buy' && op.status === 'SUCCESS' && state.connected &&
    !!op.wallet && op.wallet.toLowerCase() === state.wallet?.toLowerCase();
}
