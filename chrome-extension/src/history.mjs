const validHash = value => /^0x[0-9a-f]{64}$/i.test(value || '');
const exactId = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const onBsc = row => row.binanceChainId === undefined || String(row.binanceChainId) === '56';

// Raw history may call the execute order ID binanceTxId. Match the exact ID,
// never a nearby timestamp, token address, or the first hash in the response.
export function historyTransactionHash(history, orderId) {
  const target = exactId(orderId);
  if (!target) return null;
  const hashes = new Map();
  const add = row => { if (onBsc(row) && validHash(row.txHash)) hashes.set(row.txHash.toLowerCase(), row.txHash); };
  const visit = row => {
    if (!row || typeof row !== 'object') return;
    if (!onBsc(row)) return;
    if (['orderId', 'binanceTxId'].some(key => exactId(row[key]) === target)) {
      add(row);
      // Inspect both fields: a valid top-level hash must not hide a conflict.
      for (const child of Array.isArray(row.txHashList) ? row.txHashList : []) {
        if (!child || typeof child !== 'object') continue;
        if (child.binanceChainId === undefined && row.binanceChainId === undefined) continue;
        add({ ...child, binanceChainId: child.binanceChainId ?? row.binanceChainId });
      }
    }
    for (const child of Object.values(row)) if (child && typeof child === 'object') visit(child);
  };
  visit(history);
  if (hashes.size > 1) throw Object.assign(new Error('同一订单号对应多个交易哈希，请核对原订单；不会猜测或重发'), { code: 'AMBIGUOUS_HISTORY' });
  return hashes.values().next().value || null;
}
