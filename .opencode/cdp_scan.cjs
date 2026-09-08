// Reusable live-page scanner. Usage: CDP_WS=<ws> node cdp_scan.cjs
// Returns a compact findings object for the current page state.
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
  const res = await send("Runtime.evaluate", {
    expression: `(() => {
      const out = {};
      const q = (s) => Array.from(document.querySelectorAll(s));
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 1 && r.height > 1;
      };

      out.url = location.pathname;
      out.headings = q("h1,h2,h3,h4,h5,h6").map(h => h.tagName.toLowerCase() + ":" + (h.textContent||"").trim().slice(0,50));
      out.buttons = q("button").filter(visible).map(b => {
        const txt = (b.textContent||"").trim().slice(0,40);
        return { text: txt, aria: b.getAttribute("aria-label")||null, pressed: b.getAttribute("aria-pressed"), title: b.getAttribute("title"), cls: (b.className||"").slice(0,55) };
      });
      out.buttonsNoName = out.buttons.filter(b => !b.text && !b.aria && !b.title);
      out.inputs = q("input,select,textarea").filter(visible).map(i => ({
        type: i.getAttribute("type"), name: i.getAttribute("name"), id: i.id,
        placeholder: i.getAttribute("placeholder"), aria: i.getAttribute("aria-label")||null,
        autocomplete: i.getAttribute("autocomplete"), labelFor: (i.id && document.querySelector('label[for="'+i.id+'"]')) ? true : false,
        wrapped: !!i.closest("label"), cls: (i.className||"").slice(0,50)
      }));
      out.inputsNoLabel = out.inputs.filter(i => !i.aria && !i.labelFor && !i.wrapped);
      out.inputsNoAutocomplete = out.inputs.filter(i => !i.autocomplete && ["text","email","tel","number"].includes(i.type||""));
      out.dropdowns = q("select").length;
      out.imgs = q("img").filter(visible).map(im => ({ src:(im.getAttribute("src")||"").slice(0,55), alt: im.getAttribute("alt"), w: im.getAttribute("width"), h: im.getAttribute("height"), loading: im.getAttribute("loading"), fp: im.getAttribute("fetchpriority") }));
      out.imgsNoAlt = out.imgs.filter(i => i.alt === null);
      out.imgsNoDim = out.imgs.filter(i => !i.w || !i.h);
      out.dialog = q("[role=dialog], dialog").map(d => ({ role: d.getAttribute("role"), ariaModal: d.getAttribute("aria-modal"), ariaLabelledby: d.getAttribute("aria-labelledby"), ariaLabel: d.getAttribute("aria-label") }));
      out.overflow = q("*").filter(visible).filter(el => {
        const r = el.getBoundingClientRect();
        return r.right > document.documentElement.clientWidth + 1 || r.left < -1;
      }).map(el => el.tagName.toLowerCase() + "." + ((el.className&&typeof el.className==="string")?el.className.split(" ")[0]:"")).slice(0,8);
      out.ariaLive = q("[aria-live]").filter(visible).map(e => e.getAttribute("aria-live") + ":" + (e.tagName.toLowerCase()));
      out.emoji = q("body *").map(e => (e.childElementCount===0 ? (e.textContent||"") : "")).filter(t => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)).slice(0,5);
      out.transitionAll = q("button,a,input,[role=button]").filter(visible).filter(el => (el.className||"").includes("transition-all")).length;
      out.outlineNone = q("button,a,input,select,textarea").filter(visible).filter(el => {
        const c = el.className||"";
        return c.includes("outline-none") && !c.includes("focus-visible:ring") && !c.includes("focus:ring-1");
      }).map(el => (el.className||"").slice(0,70)).slice(0,8);
      out.clsSelectors = {};
      out.copy = q("h1,h2,h3,p,li,label,span,button,a").map(e => ({ tag: e.tagName.toLowerCase(), text: e.childNodes.length ? Array.from(e.childNodes).filter(n=>n.nodeType===3).map(n=>n.nodeValue).join("").trim() : "", full: e.textContent.trim() }))
        .filter(x => x.tag === "span" ? x.text.length>1 : true)
        .map(x => x.text || x.full)
        .filter(t => t.length > 0 && t.length < 160);
      return out;
    })()`,
    returnByValue: true
  });
  const v = res.result.value;
  console.log("=== PAGE:", v.url, "===");
  console.log("HEADINGS:", JSON.stringify(v.headings));
  console.log("BUTTONS:", JSON.stringify(v.buttons, null, 0));
  console.log("BUTTONS-NO-NAME:", JSON.stringify(v.buttonsNoName));
  console.log("INPUTS:", JSON.stringify(v.inputs, null, 0));
  console.log("INPUTS-NO-LABEL:", JSON.stringify(v.inputsNoLabel));
  console.log("INPUTS-NO-AUTOFILL:", JSON.stringify(v.inputsNoAutocomplete));
  console.log("IMGS:", JSON.stringify(v.imgs, null, 0));
  console.log("IMGS-NO-ALT:", JSON.stringify(v.imgsNoAlt));
  console.log("IMGS-NO-DIM:", JSON.stringify(v.imgsNoDim));
  console.log("DIALOGS:", JSON.stringify(v.dialog));
  console.log("OVERFLOW:", JSON.stringify(v.overflow));
  console.log("ARIA-LIVE:", JSON.stringify(v.ariaLive));
  console.log("EMOJI:", JSON.stringify(v.emoji));
  console.log("TRANSITION-ALL COUNT:", v.transitionAll);
  console.log("OUTLINE-NONE-NO-RING:", JSON.stringify(v.outlineNone));
  console.log("COPY:", JSON.stringify(v.copy.slice(0,60), null, 0));
  ws.close();
  setTimeout(() => process.exit(0), 200);
})();