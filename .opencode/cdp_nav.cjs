// Navigate the current page to a URL (SPA) and wait. Usage: CDP_WS=... CDP_URL=... node cdp_nav.cjs
const WebSocket = require("ws");
const ws = new WebSocket(process.env.CDP_WS);
let id = 1;
const pending = new Map();
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
function send(method, params = {}) {
  const i = id++;
  return new Promise((r, rj) => { pending.set(i, { resolve: r, reject: rj }); ws.send(JSON.stringify({ id: i, method, params })); });
}
(async () => {
  await new Promise((r) => ws.once("open", r));
  const url = process.env.CDP_URL || "http://localhost:3000/";
  const res = await send("Runtime.evaluate", {
    expression: `(async () => { const url = ${JSON.stringify(url)};
      if (location.pathname + location.search === new URL(url).pathname + new URL(url).search) { window.__navDone = true; return {navigated:false, url: location.href}; }
      window.__navDone = false;
      history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await new Promise(r => setTimeout(r, 1200));
      window.__navDone = true;
      return { navigated: true, url: location.href };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log(JSON.stringify(res.result.value));
  ws.close();
  setTimeout(() => process.exit(0), 200);
})();