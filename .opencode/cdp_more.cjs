const WebSocket = require("ws");
const wsUrl = process.env.CDP_WS;
const ws = new WebSocket(wsUrl);
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
  const res = await send("Runtime.evaluate", {
    expression: `(() => {
      const out = {};
      // Menu item card structure - find "Add" buttons
      const addBtns = Array.from(document.querySelectorAll("button")).filter(b => b.textContent.trim() === "Add");
      out.addBtns = addBtns.map(b => {
        const r = b.getBoundingClientRect();
        const parent = b.parentElement;
        return {
          html: b.outerHTML.slice(0, 200),
          parentTag: parent?.tagName,
          parentCls: (parent?.getAttribute("class")||"").slice(0,60),
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
        };
      });
      // The two no-name buttons - the floating round one at bottom right
      const roundBtn = Array.from(document.querySelectorAll("button")).find(b => b.className.includes("rounded-full") && b.className.includes("p-4"));
      out.roundBtn = roundBtn ? {
        html: roundBtn.outerHTML.slice(0, 300),
        text: roundBtn.textContent,
        innerHtml: roundBtn.innerHTML.slice(0, 200),
        x: Math.round(roundBtn.getBoundingClientRect().x), y: Math.round(roundBtn.getBoundingClientRect().y)
      } : null;
      // The cart-like header button
      const headerBtn = Array.from(document.querySelectorAll("header button")).filter(b => b.className.includes("p-2.5")).map(b => ({ text: b.textContent, cls: (b.getAttribute("class")||"").slice(0,80), inner: b.innerHTML.slice(0,150), ariaLabel: b.getAttribute("aria-label") }));
      out.headerBtn = headerBtn;
      // notification warnings
      const notif = document.querySelector("header button[aria-label='Notifications']");
      out.notifBell = notif ? { inner: notif.innerHTML.slice(0,150), badge: notif.querySelector(".bg-amber-500, .bg-red-500, span")?.textContent } : null;
      // Tab/filter buttons - do they have aria-pressed?
      const filters = Array.from(document.querySelectorAll("button")).filter(b => (b.textContent||"").trim() === "All Items" || /FOOD|Beverages/.test(b.textContent||""));
      out.filterBtns = filters.map(b => ({ text: b.textContent.trim(), ariaPressed: b.getAttribute("aria-pressed"), cls: (b.getAttribute("class")||"").slice(0,60) }));
      // about copy
      const about = Array.from(document.querySelectorAll("p")).find(p => p.textContent.includes("We are an located"));
      out.aboutText = about?.textContent || null;
      // images count
      out.imgs = document.querySelectorAll("img").length;
      return out;
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(res.result.value, null, 2));
  ws.close();
  setTimeout(() => process.exit(0), 300);
})();