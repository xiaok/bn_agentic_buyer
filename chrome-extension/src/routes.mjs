export const SITE_HOSTS = ['four.meme', 'flap.sh', 'gang.fun'];
export function allowedSite(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && SITE_HOSTS.includes(u.hostname); } catch { return false; }
}
export function tokenFromUrl(value) {
  if (!allowedSite(value)) return null;
  const u = new URL(value), candidates = [];
  const valid = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
  for (const [key, value] of u.searchParams) if (/^(token|market|address|contractAddress|tokenAddress)$/i.test(key) && valid(value)) candidates.push(value);
  // Never scan arbitrary 0x strings in page text or select the first card in a list.
  for (const part of u.pathname.split('/')) if (valid(part)) candidates.push(part);
  const fragment = u.hash.slice(1);
  if (valid(fragment)) candidates.push(fragment);
  const unique = [...new Map(candidates.map(value => [value.toLowerCase(), value])).values()];
  return unique.length === 1 ? unique[0] : null;
}
export function validateMessage(message, sender, extensionId) {
  if (sender.id !== extensionId || sender.frameId && sender.frameId !== 0) throw new Error('不允许此消息来源');
  let own = false;
  try { own = new URL(sender.url).origin === 'chrome-extension://' + extensionId; } catch { /* reject below */ }
  // URL.origin is "null" for extension URLs in some non-Chrome runtimes.
  own ||= String(sender.url || '').startsWith('chrome-extension://' + extensionId + '/');
  if (!own && !allowedSite(sender.url)) throw new Error('不允许此网页');
  const allowed = own ? ['VIEW', 'CONNECT', 'POLL_LOGIN', 'SIGN_OUT', 'SESSION', 'CONFIG', 'BUY', 'SELL', 'RESUME', 'FORCE_UNLOCK', 'OPEN'] : ['VIEW', 'BUY', 'RESUME', 'OPEN'];
  if (!allowed.includes(message?.type)) throw new Error('不允许此指令');
  return { own };
}
