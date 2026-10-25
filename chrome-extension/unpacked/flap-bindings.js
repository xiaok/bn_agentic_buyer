// Read-only page metadata adapter. No wallet API, credentials or order messages.
// The current Flap market cards use their exact Market address as React key.
// Never infer addresses from a symbol/name or from the ordering of an API list.
(() => {
  if (location.pathname !== '/apps/agent-bonding-curve') return;
  function scan() {
    for (const card of document.querySelectorAll('button.group,[role="button"].group')) {
      const fiberName = Object.getOwnPropertyNames(card).find(key => key.startsWith('__reactFiber$'));
      const key = fiberName && card[fiberName]?.key;
      if (/^0x[0-9a-fA-F]{40}$/.test(key || '') && /曲线|曲線|毕业|畢業|curve|graduated/i.test(card.textContent)) card.setAttribute('data-agent-trade-market', key);
      else card.removeAttribute('data-agent-trade-market');
    }
  }
  scan(); setInterval(scan, 1000);
})();
