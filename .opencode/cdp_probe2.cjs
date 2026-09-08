const WebSocket = require("ws");
const fs = require("fs");
const ws = new WebSocket("ws://127.0.0.1:9222/devtools/page/47826B4148DEB60CC1C39BA757285134");
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
      events.push({ type: t, text: (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" ").slice(0, 200) });
    }
  } else if (m.method === "Runtime.exceptionThrown") {
    const e = m.params.exceptionDetails;
    events.push({ type: "exception", text: (e.text || e.exception?.description || "").slice(0, 200) });
  } else if (m.method === "Network.loadingFailed") {
    events.push({ type: "netfail", text: m.params.errorText });
  } else if (m.method === "Network.responseReceived") {
    const r = m.params.response;
    if (r.status >= 400) events.push({ type: "http" + r.status, text: (r.url || "").slice(0, 120) });
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
  await send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 8000));

  const dom = await send("Runtime.evaluate", {
    expression: `(() => ({
      url: location.href,
      title: document.title,
      rootText: (document.getElementById("root")?.textContent || "").trim().slice(0, 400),
      rootHTMLlen: document.getElementById("root")?.innerHTML?.length || 0,
      buttons: document.querySelectorAll("button").length,
      inputs: document.querySelectorAll("input").length,
      imgs: document.querySelectorAll("img").length,
      serving_time: document.querySelector("main")?.firstElementChild?.textContent?.slice(0,80) || null
    }))()`,
    returnByValue: true
  });
  console.log("DOM:", JSON.stringify(dom.result.value, null, 2));

  const a11y = await send("Runtime.evaluate", {
    expression: `(() => {
      const issues = [];
      document.querySelectorAll("button").forEach((b) => {
        const txt = (b.textContent || "").trim();
        const aria = b.getAttribute("aria-label");
        const title = b.getAttribute("title");
        if (!txt && !aria && !title) issues.push({ kind: "button-no-name", html: b.outerHTML.slice(0, 140) });
      });
      document.querySelectorAll("input, select, textarea").forEach((inp) => {
        const type = (inp.getAttribute("type") || "").toLowerCase();
        if (["hidden","submit","button"].includes(type)) return;
        const id = inp.id;
        const aria = inp.getAttribute("aria-label") || inp.getAttribute("aria-labelledby");
        const labels = id ? document.querySelectorAll('label[for="' + id + '"]') : [];
        if (!aria && labels.length === 0 && !inp.closest("label")) {
          issues.push({ kind: "input-no-label", type, placeholder: inp.getAttribute("placeholder"), html: inp.outerHTML.slice(0, 160) });
        }
      });
      document.querySelectorAll("img").forEach((img) => {
        if (!img.hasAttribute("alt")) issues.push({ kind: "img-no-alt", src: (img.getAttribute("src") || "").slice(0, 60) });
      });
      return issues;
    })()`,
    returnByValue: true
  });
  console.log("A11Y issues: " + a11y.result.value.length);
  a11y.result.value.forEach((i) => console.log("  -", JSON.stringify(i)));

  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 75 });
  fs.writeFileSync("C:\\Users\\c\\AppData\\Local\\Temp\\opencode\\savory_live_2.jpg", Buffer.from(shot.data, "base64"));
  console.log("screenshot saved");

  console.log("EVENTS:");
  events.forEach((e) => console.log("  [" + e.type + "]", e.text));
  ws.close();
  setTimeout(() => process.exit(0), 300);
})();