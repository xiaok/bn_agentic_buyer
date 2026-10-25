export function createNotice(root) {
  const style = document.createElement('style');
  style.textContent = `.trade-notice{position:fixed;top:24px;right:24px;z-index:2147483647;width:320px;max-width:calc(100vw - 40px);padding:18px 40px 18px 18px;border-radius:12px;background:#192332;border:1px solid #e2b83d;color:#f0f4fa;box-shadow:0 12px 48px #0008;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere;animation:trade-notice-in .18s ease-out}.trade-notice[hidden]{display:none}.trade-notice[data-kind=success]{border-color:#56ce9f;background:#132b25}.trade-notice[data-kind=error]{border-color:#ed8795;background:#321c27}.trade-notice strong{font-size:16px}.trade-notice p{font-size:12px;margin:7px 0;color:#ced7e5;white-space:pre-wrap}.trade-notice a{color:#f3c742;font-size:12px}.trade-notice .notice-close{position:absolute;right:9px;top:7px;padding:3px 7px;background:transparent;border:0;color:#b9c6d8;font:20px system-ui;cursor:pointer}@keyframes trade-notice-in{from{transform:translateY(-8px);opacity:0}to{transform:translateY(0);opacity:1}}`;
  root.append(style);
  const box = document.createElement('div'); box.className = 'trade-notice'; box.hidden = true;
  box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite');
  const close = document.createElement('button'); close.type = 'button'; close.className = 'notice-close';
  close.textContent = '×'; close.setAttribute('aria-label', '关闭交易提示');
  const title = document.createElement('strong'), detail = document.createElement('p'), link = document.createElement('a');
  link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看链上交易 ↗';
  close.addEventListener('click', () => { box.hidden = true; });
  box.append(close, title, detail, link); root.append(box);
  let timer;
  return (heading, message, kind = 'pending', hash) => {
    clearTimeout(timer); box.hidden = false; box.dataset.kind = kind;
    title.textContent = heading; detail.textContent = message;
    link.hidden = !/^0x[0-9a-f]{64}$/i.test(hash || '');
    if (!link.hidden) link.href = 'https://bscscan.com/tx/' + hash;
    if (kind === 'success') timer = setTimeout(() => { box.hidden = true; }, 10000);
  };
}
