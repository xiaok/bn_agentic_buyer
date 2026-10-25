(() => {
  // src/routes.mjs
  var SITE_HOSTS = ["four.meme", "flap.sh", "gang.fun"];
  function allowedSite(value) {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && SITE_HOSTS.includes(u.hostname);
    } catch {
      return false;
    }
  }
  function tokenFromUrl(value) {
    if (!allowedSite(value)) return null;
    const u = new URL(value), candidates = [];
    const valid = (value2) => /^0x[0-9a-fA-F]{40}$/.test(value2 || "");
    for (const [key, value2] of u.searchParams) if (/^(token|market|address|contractAddress|tokenAddress)$/i.test(key) && valid(value2)) candidates.push(value2);
    for (const part of u.pathname.split("/")) if (valid(part)) candidates.push(part);
    const fragment = u.hash.slice(1);
    if (valid(fragment)) candidates.push(fragment);
    const unique = [...new Map(candidates.map((value2) => [value2.toLowerCase(), value2])).values()];
    return unique.length === 1 ? unique[0] : null;
  }

  // src/page-address.mjs
  function flapMarketFromDocument(doc) {
    const candidates = /* @__PURE__ */ new Map();
    for (const label of doc.querySelectorAll("span,div,p,dt,label,strong")) {
      if (label.children.length || !/^(?:Market\s*(?:地址|Address)|市场地址|市場地址)$/i.test(label.textContent.trim()) || !label.getClientRects().length) continue;
      let container = label.parentElement;
      for (let depth = 0; container && depth < 3; depth++, container = container.parentElement) {
        const addresses = [...new Set((container.innerText.match(/0x[0-9a-fA-F]{40}/g) || []).map((x) => x.toLowerCase()))];
        if (addresses.length === 1) {
          candidates.set(addresses[0], addresses[0]);
          break;
        }
        if (addresses.length > 1) break;
      }
    }
    return candidates.size === 1 ? [...candidates.values()][0] : null;
  }
  function tokenFromPage(doc, url) {
    if (!allowedSite(url)) return null;
    const direct = tokenFromUrl(url);
    if (direct) return direct;
    const parsed = new URL(url);
    if (parsed.hostname === "flap.sh" && parsed.pathname === "/apps/agent-bonding-curve") return flapMarketFromDocument(doc);
    return null;
  }

  // src/order-ui.mjs
  var isFinished = (op) => ["SUCCESS", "FAILED", "BLOCKED"].includes(op.status);
  var orderHash = (op) => op.result?.txHash || [...op.steps].reverse().find((step) => step.txHash)?.txHash;
  function orderLabel(op) {
    const side = op.intent.side === "buy" ? "\u4E70\u5165" : "\u5356\u51FA";
    return {
      SUCCESS: `${side}\u6210\u529F`,
      FAILED: `${side}\u5931\u8D25`,
      BLOCKED: `${side}\u5DF2\u505C\u6B62`,
      RUNNING: `${side}\u4E2D\u2026`,
      PENDING: "\u7B49\u5F85\u786E\u8BA4\uFF0F\u7EE7\u7EED\u539F\u8BA2\u5355",
      PENDING_CONFIRMATION: "\u7B49\u5F85 App \u786E\u8BA4",
      SUBMISSION_UNKNOWN: "\u63D0\u4EA4\u7ED3\u679C\u5F85\u6838\u5B9E\uFF0C\u8BF7\u52FF\u91CD\u590D\u4E0B\u5355"
    }[op.status] || op.status;
  }
  function orderDetail(op) {
    if (op.status === "SUCCESS") return "\u4EA4\u6613\u5DF2\u5728\u94FE\u4E0A\u786E\u8BA4";
    return op.error?.message || op.progress?.message || op.progress?.phase || "\u6B63\u5728\u5904\u7406\uFF0C\u8BF7\u52FF\u91CD\u590D\u70B9\u51FB";
  }

  // src/notice.mjs
  function createNotice(root) {
    const style = document.createElement("style");
    style.textContent = `.trade-notice{position:fixed;top:24px;right:24px;z-index:2147483647;width:320px;max-width:calc(100vw - 40px);padding:18px 40px 18px 18px;border-radius:12px;background:#192332;border:1px solid #e2b83d;color:#f0f4fa;box-shadow:0 12px 48px #0008;font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere;animation:trade-notice-in .18s ease-out}.trade-notice[hidden]{display:none}.trade-notice[data-kind=success]{border-color:#56ce9f;background:#132b25}.trade-notice[data-kind=error]{border-color:#ed8795;background:#321c27}.trade-notice strong{font-size:16px}.trade-notice p{font-size:12px;margin:7px 0;color:#ced7e5;white-space:pre-wrap}.trade-notice a{color:#f3c742;font-size:12px}.trade-notice .notice-close{position:absolute;right:9px;top:7px;padding:3px 7px;background:transparent;border:0;color:#b9c6d8;font:20px system-ui;cursor:pointer}@keyframes trade-notice-in{from{transform:translateY(-8px);opacity:0}to{transform:translateY(0);opacity:1}}`;
    root.append(style);
    const box = document.createElement("div");
    box.className = "trade-notice";
    box.hidden = true;
    box.setAttribute("role", "status");
    box.setAttribute("aria-live", "polite");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "notice-close";
    close.textContent = "\xD7";
    close.setAttribute("aria-label", "\u5173\u95ED\u4EA4\u6613\u63D0\u793A");
    const title = document.createElement("strong"), detail = document.createElement("p"), link = document.createElement("a");
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "\u67E5\u770B\u94FE\u4E0A\u4EA4\u6613 \u2197";
    close.addEventListener("click", () => {
      box.hidden = true;
    });
    box.append(close, title, detail, link);
    root.append(box);
    let timer;
    return (heading, message, kind = "pending", hash) => {
      clearTimeout(timer);
      box.hidden = false;
      box.dataset.kind = kind;
      title.textContent = heading;
      detail.textContent = message;
      link.hidden = !/^0x[0-9a-f]{64}$/i.test(hash || "");
      if (!link.hidden) link.href = "https://bscscan.com/tx/" + hash;
      if (kind === "success") timer = setTimeout(() => {
        box.hidden = true;
      }, 1e4);
    };
  }

  // src/content.mjs
  if (window.top === window && !document.querySelector("agent-trade-chrome")) {
    let update = function() {
      if (selection && (selection.url !== location.href || !selection.element.isConnected || candidateFor(selection.element) !== selection.token)) selection = null;
      token = tokenFromPage(document, location.href) || selection?.token || null;
      $(".address").textContent = token || "\u8BF7\u6253\u5F00\u5E01\u7684\u8BE6\u60C5\uFF0C\u6216\u4F7F\u7528\u6761\u76EE\u65C1\u7684\u4E70\u5165\u6309\u94AE\u3002";
      $(".buy").textContent = connected ? `\u4E70\u5165 ${config?.buyAmountBnb || "0.001"} BNB` : "\u8FDE\u63A5\u94B1\u5305";
      $(".buy").disabled = posting || connected && (!token || !config || !!pending);
      $(".resume").classList.toggle("hidden", !pending || pending.status === "RUNNING" || posting);
      for (const item of cards.values()) {
        item.button.textContent = connected ? `\u4E70 ${config?.buyAmountBnb || "0.001"} BNB` : "\u8FDE\u63A5\u540E\u4E70\u5165";
        item.button.disabled = posting || !!pending;
      }
    }, candidateFor = function(element) {
      if (location.hostname === "flap.sh") {
        const value = element.getAttribute("data-agent-trade-market");
        return /^0x[0-9a-fA-F]{40}$/.test(value || "") ? value : null;
      }
      try {
        const url = new URL(element.href);
        return url.hostname === location.hostname && /\/(?:token|market)\/0x[0-9a-fA-F]{40}(?:\/|$)/.test(url.pathname) ? tokenFromUrl(url.href) : null;
      } catch {
        return null;
      }
    }, scanCards = function() {
      const nodes = location.hostname === "flap.sh" ? document.querySelectorAll("[data-agent-trade-market]") : document.querySelectorAll("a[href]");
      for (const [element, record] of cards) if (!element.isConnected || candidateFor(element) !== record.token) {
        record.host.remove();
        cards.delete(element);
      }
      for (const element of nodes) {
        const address = candidateFor(element);
        if (!address || cards.has(element) || !element.getClientRects().length || cards.size >= 200) continue;
        if (location.hostname === "gang.fun" && /买了|bought/i.test(element.textContent)) continue;
        const badge = document.createElement("agent-trade-buy");
        const root = badge.attachShadow({ mode: "closed" });
        root.innerHTML = '<style>:host{all:initial!important;display:inline-flex!important;position:relative!important;z-index:40!important;margin:4px!important;vertical-align:middle!important}button{border:1px solid #9d7e1d;border-radius:6px;background:#f3c742;color:#151515;padding:5px 8px;font:700 11px/1.4 system-ui,sans-serif;cursor:pointer;white-space:nowrap}button:disabled{opacity:.45;cursor:default}</style><button type="button"></button>';
        const button = root.querySelector("button");
        button.title = address;
        const choose = (event) => {
          if (event.isTrusted) {
            selection = { token: address, element, url: location.href };
            update();
          }
        };
        badge.addEventListener("pointerenter", choose);
        button.addEventListener("click", async (event) => {
          if (!event.isTrusted) return;
          event.preventDefault();
          event.stopPropagation();
          if (candidateFor(element) !== address) {
            showError(new Error("\u6761\u76EE\u5730\u5740\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u70B9\u51FB"));
            return;
          }
          selection = { token: address, element, url: location.href };
          update();
          await submit(address);
        });
        element.appendChild(badge);
        cards.set(element, { host: badge, button, token: address });
      }
      update();
    };
    const host = document.createElement("agent-trade-chrome");
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
    :host{all:initial;position:fixed!important;right:18px!important;bottom:24px!important;z-index:2147483647!important;font:13px/1.5 system-ui,sans-serif!important;color:#f4f5f7!important}
    .box{width:280px;background:#151922;border:1px solid #404856;border-radius:14px;padding:14px;box-shadow:0 12px 40px #0006}
    .head{display:flex;justify-content:space-between;align-items:center;font-weight:700}.label{font-size:11px;color:#a8b3c5;letter-spacing:.08em}
    button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:9px 12px;background:#f5c842;color:#151515;font-weight:750}
    button:disabled{opacity:.5;cursor:default}.settings{background:transparent;color:#bac5d7;font-size:12px;padding:4px}
    .address{font:11px/1.6 ui-monospace,monospace;overflow-wrap:anywhere;color:#d3dcec;margin:9px 0;min-height:34px}
    .buy{width:100%;margin-bottom:7px}.status{white-space:pre-wrap;font-size:12px;color:#afbdd0;overflow-wrap:anywhere;max-height:140px;overflow:auto}
    .resume{background:#2b3547;color:#edf1f7;margin:8px 0 0;width:100%}.hidden{display:none}a{color:#f5c842}
    .platforms{display:flex;gap:8px;margin:9px 0 4px}.platforms a{flex:1;text-align:center;text-decoration:none;border:1px solid #404856;border-radius:6px;padding:4px;font-size:11px}.platforms a:hover{background:#30394b}
  </style><div class="box"><div class="head"><span>Agent Trade</span><button class="settings" type="button">\u8BBE\u7F6E \u2197</button></div>
  <nav class="platforms" aria-label="\u4EA4\u6613\u5E73\u53F0"><a href="https://gang.fun/" target="_blank" rel="noopener noreferrer">Gang \u2197</a><a href="https://flap.sh/apps/agent-bonding-curve?lang=zh" target="_blank" rel="noopener noreferrer">Flap \u2197</a><a href="https://four.meme/zh-TW/contract/1778027615735" target="_blank" rel="noopener noreferrer">Four \u2197</a></nav><div class="label">BSC \xB7 \u4E00\u952E\u4E70\u5165</div><div class="address"></div><button class="buy" type="button">\u8FDE\u63A5\u94B1\u5305</button>
  <div class="status">\u8BFB\u53D6\u6269\u5C55\u72B6\u6001\u2026</div><button class="resume hidden" type="button">\u7EE7\u7EED\u539F\u8BA2\u5355</button></div>`;
    document.documentElement.appendChild(host);
    const $ = (selector) => shadow.querySelector(selector);
    const notify = createNotice(shadow);
    let token = null, config = null, connected = false, pending = null, posting = false, selection = null;
    let watchedOrder = null, watchedState;
    const cards = /* @__PURE__ */ new Map();
    const send = async (message) => {
      const result = await chrome.runtime.sendMessage(message);
      if (!result?.ok) throw new Error(result?.error?.message || "\u6269\u5C55\u8FDE\u63A5\u4E2D\u65AD\uFF1B\u8BF7\u6253\u5F00\u8BBE\u7F6E\u67E5\u770B\u539F\u8BA2\u5355");
      return result.data;
    };
    $(".settings").addEventListener("click", (event) => {
      if (event.isTrusted) send({ type: "OPEN" }).catch(showError);
    });
    const showError = (error) => {
      $(".status").textContent = error.message;
    };
    async function submit(clickedToken) {
      if (posting || pending) return;
      if (!connected || !clickedToken || !config) {
        await send({ type: "OPEN" }).catch(showError);
        return;
      }
      const amount = config.buyAmountBnb, id = crypto.randomUUID();
      watchedOrder = id;
      watchedState = void 0;
      posting = true;
      update();
      $(".status").textContent = "\u6B63\u5728\u63D0\u4EA4\uFF0C\u8BF7\u52FF\u91CD\u590D\u70B9\u51FB\u2026";
      notify("\u6B63\u5728\u4E70\u5165\u2026", `${amount} BNB
${clickedToken}
\u8BF7\u52FF\u91CD\u590D\u70B9\u51FB`);
      try {
        await send({ type: "BUY", token: clickedToken, amount, id });
        await refresh();
      } catch (e) {
        showError(e);
        notify("\u63D0\u4EA4\u672A\u5B8C\u6210", e.message, "error");
      } finally {
        posting = false;
        update();
      }
    }
    $(".buy").addEventListener("click", async (event) => {
      if (!event.isTrusted) return;
      await submit(token);
    });
    $(".resume").addEventListener("click", async (event) => {
      if (!event.isTrusted || !pending || posting) return;
      posting = true;
      update();
      try {
        await send({ type: "RESUME", id: pending.id });
        await refresh();
      } catch (e) {
        showError(e);
      } finally {
        posting = false;
        update();
      }
    });
    async function refresh() {
      try {
        const state = await send({ type: "VIEW" });
        config = state.config;
        connected = state.connected;
        pending = state.operations.find((op) => !isFinished(op));
        const watched = state.operations.find((op) => op.id === watchedOrder);
        if (watched && watchedState !== watched.status) {
          watchedState = watched.status;
          notify(orderLabel(watched), orderDetail(watched), watched.status === "SUCCESS" ? "success" : isFinished(watched) ? "error" : "pending", orderHash(watched));
        }
        const current = pending || state.operations.find((op) => op.intent.token.toLowerCase() === token?.toLowerCase()) || watched;
        if (current) {
          const hash = orderHash(current);
          $(".status").textContent = `${orderLabel(current)}
${orderDetail(current)}`;
          if (/^0x[0-9a-f]{64}$/i.test(hash || "")) {
            const a = document.createElement("a");
            a.textContent = "\u67E5\u770B\u4EA4\u6613 \u2197";
            a.href = "https://bscscan.com/tx/" + hash;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            $(".status").appendChild(document.createElement("br"));
            $(".status").appendChild(a);
          }
        } else $(".status").textContent = connected ? "\u70B9\u51FB\u5373\u6309\u663E\u793A\u91D1\u989D\u6267\u884C \xB7 gas \u53E6\u8BA1" : "\u5148\u5728\u6269\u5C55\u8BBE\u7F6E\u91CC\u5B8C\u6210 Binance App \u914D\u5BF9";
        if (pending && !state.busy) $(".resume").classList.remove("hidden");
        update();
        if (pending && !state.busy && !posting) $(".resume").classList.remove("hidden");
      } catch (e) {
        showError(e);
      }
    }
    update();
    scanCards();
    refresh();
    setInterval(() => {
      scanCards();
      refresh();
    }, 1e3);
  }
})();
