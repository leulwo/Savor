const WebSocket = require("ws");
const fs = require("fs");

const ws = new WebSocket("ws://127.0.0.1:9222/devtools/page/47826B4148DEB60CC1C39BA757285134");
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
  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: true });
  fs.writeFileSync("C:\\Users\\c\\AppData\\Local\\Temp\\opencode\\savory_live.jpg", Buffer.from(shot.data, "base64"));
  console.log("saved");
  ws.close();
  process.exit(0);
})();