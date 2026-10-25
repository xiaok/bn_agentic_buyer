const validHash = value => /^0x[0-9a-f]{64}$/i.test(value || '');
const onBsc = row => row.binanceChainId === undefined || String(row.binanceChainId) === '56';

// Raw history may call the execute order ID binanceTxId. Match the exact ID,
// never a nearby timestamp, token address, or the first hash in the response.
export function historyTransactionHash(history, orderId) {
  if (orderId === undefined || orderId === null || orderId === '') return null;
  const hashes = new Map();
  const add = row => { if (onBsc(row) && validHash(row.txHash)) hashes.set(row.txHash.toLowerCase(), row.txHash); };
  const visit = row => {
    if (!row || typeof row !== 'object') return;
    if (onBsc(row) && ['orderId', 'binanceTxId'].some(key => row[key] !== undefined && String(row[key]) === String(orderId))) {
      if (validHash(row.txHash)) add(row);
      else for (const child of row.txHashList || []) add(child);
    }
    for (const child of Object.values(row)) if (child && typeof child === 'object') visit(child);
  };
  visit(history);
  if (hashes.size > 1) throw Object.assign(new Error('同一订单号对应多个交易哈希，请核对原订单；不会猜测或重发'), { code: 'AMBIGUOUS_HISTORY' });
  return hashes.values().next().value || null;
}
