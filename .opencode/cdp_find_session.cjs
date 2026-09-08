const WebSocket = require("ws");
const fs = require("fs");
// Page: try each SAVORY tab until we find one signed in
async function probe(wsUrl, label) {
  return new Promise((resolve) => {
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
    ws.on("error", () => resolve({ label, error: "ws-error" }));
    ws.on("open", async () => {
      try {
        const res = await send("Runtime.evaluate", {
          expression: `(() => {
            const root = document.getElementById("root");
            return {
              url: location.href,
              text: (root?.textContent || "").trim().slice(0, 500),
              buttons: document.querySelectorAll("button").length
            };
          })()`,
          returnByValue: true
        });
        resolve({ label, value: res.result.value });
      } catch (e) {
        resolve({ label, error: e.message });
      } finally {
        ws.close();
      }
    });
  });
}

async function main() {
  const tabs = (await fetch("http://127.0.0.1:9222/json").then(r => r.json()))
    .filter(t => t.type === "page" && t.url.includes("localhost:3000"));
  for (const t of tabs) {
    const r = await probe(t.webSocketDebuggerUrl, t.id);
    console.log(JSON.stringify(r));
  }
  process.exit(0);
}
main();