const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const port = 9224;
const profile = 'C:\\Users\\c\\AppData\\Local\\Temp\\opencode\\cdp_err';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fs = require('fs');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}

function getTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function run() {
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-extensions', '--no-sandbox', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  chrome.on('error', () => {});
  try {
    await new Promise(r => setTimeout(r, 3000));
    const targets = await getTarget();
    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 1; const pending = new Map();
    ws.on('message', (data) => { try { const m = JSON.parse(data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch (_) {} });
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const send = (m, p={}) => new Promise(res => { const i=id++; pending.set(i, res); ws.send(JSON.stringify({id:i,method:m,params:p})); });
    const evalExp = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return JSON.stringify(r.result?.result ?? r.result);
    };

    await send('Page.enable');
    await send('Page.navigate', { url: 'http://localhost:3000/' });
    await new Promise(r => setTimeout(r, 8000));

    // Try to read Vite error overlay text
    const overlayText = await evalExp('(() => { const o = document.querySelector(".error-overlay, .vite-error-overlay, #vite-error-overlay, .overlay"); return o ? { found: true, text: (o.innerText || o.textContent || "").slice(0,1500), html: (o.innerHTML || "").slice(0,1000) } : { found: false, bodyLen: document.body ? document.body.innerHTML.length : "none", root: document.getElementById("root") ? "exists" : "MISSING" }; })()');
    console.log('OVERLAY:', overlayText);

    // Also capture any exceptions seen by the browser
    await send('Runtime.enable');
    const rootState = await evalExp('document.getElementById("root") ? document.getElementById("root").innerHTML.slice(0,200) : "MISSING-ROOT"');
    console.log('ROOT:', rootState);
  } finally {
    try { chrome.kill('SIGKILL'); } catch (_) {}
    ws && ws.close();
    setTimeout(() => process.exit(0), 1000);
  }
}
run().catch(e => { console.error('ERR', e.message); process.exit(1); });
