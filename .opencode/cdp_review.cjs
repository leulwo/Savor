const WebSocket = require("ws");
const fs = require("fs");
const wsUrl = process.env.CDP_WS;

const ws = new WebSocket(wsUrl);
let id = 1;
const pending = new Map();
const events = [];
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  } else if (m.method === "Runtime.consoleAPICalled") {
    const t = m.params.type;
    if (t === "error" || t === "warning") {
      events.push({ type: t, text: (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 250) });
    }
  } else if (m.method === "Runtime.exceptionThrown") {
    const e = m.params.exceptionDetails;
    events.push({ type: "exception", text: (e.text || e.exception?.description || "").slice(0, 250), stack: e.stackTrace?.callFrames?.slice(0,3).map(f => f.url.split("/").pop() + ":" + (f.lineNumber+1)).join(" ") || "" });
  } else if (m.method === "Network.loadingFailed") {
    events.push({ type: "netfail", text: (m.params.errorText || "") + " " + (m.params.blockedReason || "") });
  } else if (m.method === "Network.responseReceived") {
    const r = m.params.response;
    if (r.status >= 400) events.push({ type: "http" + r.status, text: (r.url || "").slice(0, 140) });
  }
});
function send(method, params = {}) {
  const i = id++;
  return new Promise((r, rj) => { pending.set(i, { resolve: r, reject: rj }); ws.send(JSON.stringify({ id: i, method, params })); });
}

(async () => {
  await new Promise((r) => ws.once("open", r));
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 7000));

  const scans = await send("Runtime.evaluate", {
    expression: `(() => {
      const out = {};
      const q = (s) => Array.from(document.querySelectorAll(s));

      // --- ACCESSIBILITY ---
      out.a11y = {};
      out.a11y.buttonsNoName = q("button").filter(b => {
        const txt = (b.textContent || "").trim();
        const aria = b.getAttribute("aria-label") || b.getAttribute("aria-labelledby");
        const title = b.getAttribute("title");
        return !txt && !aria && !title;
      }).map(b => { const r=b.getBoundingClientRect(); return { html: b.outerHTML.slice(0,180), cls: (b.className||"").slice(0,60), x:Math.round(r.x), y:Math.round(r.y) }; });

      out.a11y.inputsNoLabel = q("input, select, textarea").filter(i => {
        const type = (i.getAttribute("type")||"").toLowerCase();
        if (["hidden","submit","button","checkbox","radio"].includes(type)) return false;
        const id = i.id;
        return !(i.getAttribute("aria-label") || i.getAttribute("aria-labelledby") || (id && document.querySelector('label[for="'+id+'"]')) || i.closest("label"));
      }).map(i => ({ type: i.getAttribute("type"), name: i.getAttribute("name"), placeholder: i.getAttribute("placeholder"), html: i.outerHTML.slice(0,180) }));

      out.a11y.imgsNoAlt = q("img").filter(im => !im.hasAttribute("alt")).map(im => ({ src: (im.getAttribute("src")||"").slice(0,70), alt: im.getAttribute("alt") }));

      out.a11y.imgsNoDim = q("img").filter(im => !im.getAttribute("width") || !im.getAttribute("height")).map(im => ({ src: (im.getAttribute("src")||"").slice(0,70), w: im.getAttribute("width"), h: im.getAttribute("height") }));

      out.a11y.lazyImages = q("img").map(im => ({ src: (im.getAttribute("src")||"").slice(0,60), loading: im.getAttribute("loading"), fetchpriority: im.getAttribute("fetchpriority") })).filter(x => !x.src.includes("logo")).slice(0,10);

      out.a11y.inputsNoAutocomplete = q("input[type=text], input[type=email], input[type=tel], input[type=number], input[name], textarea").filter(i => !i.getAttribute("autocomplete")).map(i => ({ type: i.getAttribute("type"), name: i.getAttribute("name"), placeholder: i.getAttribute("placeholder"), id: i.id }));

      out.a11y.inputsNoName = q("input, select, textarea").filter(i => !i.getAttribute("name") && !i.id && ["hidden","submit","button"].indexOf((i.getAttribute("type")||"").toLowerCase())===-1).map(i => ({ type: i.getAttribute("type"), placeholder: i.getAttribute("placeholder") }));

      out.a11y.divClick = q("[onclick], [role=button]").map(e => ({ tag: e.tagName.toLowerCase(), cls: (e.className||"").toString().slice(0,50), onclick: (e.getAttribute("onclick")||"").slice(0,50) }));

      out.a11y.ariaLive = q("main, [role=status], [role=alert], #root [aria-live]").map(e => ({ tag: e.tagName.toLowerCase(), ariaLive: e.getAttribute("aria-live"), role: e.getAttribute("role") }));

      out.a11y.headings = q("h1,h2,h3,h4,h5,h6").map(h => h.tagName.toLowerCase() + ":" + (h.textContent||"").trim().slice(0,40));

      out.a11y.skipLink = !!q("a[href='#main'], a[href='#content']").length;
      out.a11y.altOnDecoIcons = q("svg").length;

      // --- FOCUS ---
      out.focus = {};
      out.focus.outlineNone = q("button, a, input, select, textarea, [tabindex]").filter(el => {
        const cs = getComputedStyle(el);
        return cs.outlineStyle === "none" || cs.outlineWidth === "0px";
      }).map(el => ({ tag: el.tagName.toLowerCase(), cls: (el.getAttribute("class")||"").slice(0,70) })).filter((v,i,a) => a.findIndex(x => x.cls === v.cls) === i).slice(0,20);

      // titles with "..." 
      out.typography = {};
      out.typography.dots = q("h1,h2,h3,p,span,button,a,div").map(e => ({ text: (e.childNodes.length ? Array.from(e.childNodes).filter(n=>n.nodeType===3).map(n=>n.nodeValue).join("") : e.textContent)?.trim() || "", tag: e.tagName.toLowerCase() })).filter(x => x.text.length > 0 && x.text.length < 120 && x.text.includes("..."));

      out.typography.straightQuotes = q("h1,h2,h3,p,span,button,a,div,label").map(e => ({ text: e.textContent?.trim() || "", tag: e.tagName.toLowerCase() })).filter(x => x.text.length > 0 && /["']/.test(x.text) && !/[“”‘’]/.test(x.text));

      out.typography.emDash = q("*").map(e => e.textContent?.trim().slice(0,200)).filter(t => t && t.includes("—")).filter((v,i,a) => a.indexOf(v)===i).slice(0,8);

      out.typography.loading = q("*").map(e => e.textContent?.trim()).filter(t => t && /Loading|Saving|Processing|Fetching|Updating/.test(t) && !t.includes("…")).filter((v,i,a) => a.indexOf(v)===i).slice(0,8);

      // --- BUTTONS ---
      out.buttons = q("button").map(b => {
        const r = b.getBoundingClientRect();
        return { text: (b.textContent||"").trim().slice(0,30), cls: (b.className||"").slice(0,50), x:Math.round(r.x), y:Math.round(r.y), w:Math.round(r.width), h:Math.round(r.height), aria: b.getAttribute("aria-label")||null };
      }).filter(b => b.text || b.aria);

      // --- IMAGES summary ---
      out.imgSummary = q("img").map(i => ({ src: (i.getAttribute("src")||"").slice(0,60), alt: i.getAttribute("alt"), w: i.getAttribute("width"), h: i.getAttribute("height"), loading: i.getAttribute("loading") })).slice(0,15);

      // --- overflow / layout ---
      const vw = document.documentElement.clientWidth;
      out.layout = {};
      out.layout.vw = vw;
      out.layout.overflow = q("*").filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > vw + 1 || r.left < -1);
      }).map(el => ({ tag: el.tagName.toLowerCase(), cls: (typeof el.className === "string" ? el.className.slice(0,60) : ""), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right), w: Math.round(el.getBoundingClientRect().width) })).slice(0,15);
      out.layout.imagesWithUrl = q("img").length;

      // --- semantic checks ---
      out.a11y.mainExists = !!document.querySelector("main");
      out.a11y.landmarks = q("header, nav, main, footer, aside").map(e => e.tagName.toLowerCase());
      out.tagTable = q("table").length;

      // --- page meta ---
      out.meta = {};
      out.meta.colorScheme = getComputedStyle(document.documentElement).colorScheme;
      out.meta.themeColor = q("meta[name=theme-color]").length;
      out.meta.viewport = q("meta[name=viewport]").length ? document.querySelector("meta[name=viewport]").content : null;

      return out;
    })()`,
    returnByValue: true
  });
  const v = scans.result.value;
  const print = (k) => console.log(k + ":", JSON.stringify(v[k]));
  console.log("===== A11Y =====");
  console.log(JSON.stringify(v.a11y, null, 1));
  console.log("===== FOCUS (outline none) =====");
  console.log(JSON.stringify(v.focus.outlineNone, null, 1));
  console.log("===== TYPO =====");
  console.log(JSON.stringify(v.typography, null, 1));
  console.log("===== LAYOUT =====");
  console.log(JSON.stringify(v.layout, null, 1));
  console.log("===== META =====");
  console.log(JSON.stringify(v.meta, null, 1));
  console.log("===== BUTTONS =====");
  console.log(JSON.stringify(v.buttons, null, 1));
  console.log("===== IMG SUMMARY =====");
  console.log(JSON.stringify(v.imgSummary, null, 1));

  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 75 });
  fs.writeFileSync("C:\\Users\\c\\AppData\\Local\\Temp\\opencode\\savory_signedin.jpg", Buffer.from(shot.data, "base64"));
  console.log("===== SCREENSHOT SAVED =====");

  console.log("===== EVENTS =====");
  events.forEach((e) => console.log("[" + e.type + "]", e.text, e.stack || ""));
  ws.close();
  setTimeout(() => process.exit(0), 300);
})();