export const isFinished = op => ['SUCCESS', 'FAILED', 'BLOCKED'].includes(op.status);
export const orderHash = op => op.result?.txHash || [...op.steps].reverse().find(step => step.txHash)?.txHash;
export function orderLabel(op) {
  const side = op.intent.side === 'buy' ? '买入' : '卖出';
  return ({ SUCCESS: `${side}成功`, FAILED: `${side}失败`, BLOCKED: `${side}已停止`,
    RUNNING: `${side}中…`, PENDING: '等待确认／继续原订单', PENDING_CONFIRMATION: '等待 App 确认',
    SUBMISSION_UNKNOWN: '提交结果待核实，请勿重复下单' })[op.status] || op.status;
}
export function orderDetail(op) {
  if (op.status === 'SUCCESS') return '交易已在链上确认';
  return op.error?.message || op.progress?.message || op.progress?.phase || '正在处理，请勿重复点击';
}
export function canQuickSell(op, state) {
  return op.intent.side === 'buy' && op.status === 'SUCCESS' && state.connected &&
    !!op.wallet && op.wallet.toLowerCase() === state.wallet?.toLowerCase();
}
