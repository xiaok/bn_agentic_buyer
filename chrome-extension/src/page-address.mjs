import { tokenFromUrl, allowedSite } from './routes.mjs';
export function flapMarketFromDocument(doc) {
  const candidates = new Map();
  for (const label of doc.querySelectorAll('span,div,p,dt,label,strong')) {
    if (label.children.length || !/^(?:Market\s*(?:地址|Address)|市场地址|市場地址)$/i.test(label.textContent.trim()) || !label.getClientRects().length) continue;
    let container = label.parentElement;
    for (let depth = 0; container && depth < 3; depth++, container = container.parentElement) {
      const addresses = [...new Set((container.innerText.match(/0x[0-9a-fA-F]{40}/g) || []).map(x => x.toLowerCase()))];
      if (addresses.length === 1) { candidates.set(addresses[0], addresses[0]); break; }
      if (addresses.length > 1) break;
    }
  }
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}
export function tokenFromPage(doc, url) {
  if (!allowedSite(url)) return null;
  const direct = tokenFromUrl(url);
  if (direct) return direct;
  const parsed = new URL(url);
  if (parsed.hostname === 'flap.sh' && parsed.pathname === '/apps/agent-bonding-curve') return flapMarketFromDocument(doc);
  return null;
}
