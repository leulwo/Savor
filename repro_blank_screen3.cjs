const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const port = 9225;
const profile = 'C:\\Users\\c\\AppData\\Local\\Temp\\opencode\\cdp_err3';
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fs = require('fs');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}

function getTarget() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, res => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function run() {
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--no-sandbox', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  let ws = null;
  try {
    await new Promise(r => setTimeout(r, 3000));
    const targets = await getTarget();
    const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map(); let id = 1;
    const exc = [];
    ws.on('message', (data) => {
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') exc.push(JSON.stringify(m.params?.exceptionDetails?.exception?.preview?.properties?.map(p=>p.name+':'+p.value)).slice(0,800) || m.params?.exceptionDetails?.text);
    });
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const send = (m, p={}) => new Promise(res => { const i=id++; pending.set(i, res); ws.send(JSON.stringify({id:i,method:m,params:p})); });
    const evalExp = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result?.result?.value;
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: 'http://localhost:3000/' });
    await new Promise(r => setTimeout(r, 8000));

    // Dump first 2000 chars of body
    const bodyHead = await evalExp('document.body ? document.body.innerHTML.slice(0, 2500) : "NO BODY"');
    console.log('BODY_HEAD:', bodyHead);

    const title = await evalExp('document.title');
    console.log('TITLE:', title);

    // Look for the error message text
    const errText = await evalExp('(() => { const s = Array.from(document.querySelectorAll("*")).map(n => n.innerText || n.textContent || "").join("\\n"); return s.slice(0, 3000); })()');
    console.log('TEXT_CONTENT:', errText);
  } finally {
    try { chrome.kill('SIGKILL'); } catch (_) {}
    if (ws) try { ws.close(); } catch (_) {}
    setTimeout(() => process.exit(0), 800);
  }
}
run().catch(e => { console.error('ERR', e.message); process.exit(1); });
