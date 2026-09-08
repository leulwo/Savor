// Chrome DevTools Protocol client — connects to the running Chrome with
// remote debugging on port 9222 and runs a series of introspection commands
// on the SAVORY tab. Used to do a live design / runtime review.

const WebSocket = require("ws");

const wsUrl = process.env.CDP_WS || "ws://127.0.0.1:9222/devtools/page/47826B4148DEB60CC1C39BA757285134";

let nextId = 1;
const pending = new Map();
const ws = new WebSocket(wsUrl);

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  } catch (e) {
    // ignore
  }
});

ws.on("error", (e) => {
  console.error("WS error:", e.message);
  process.exit(1);
});

function logSection(title) {
  console.log("\n" + "=".repeat(60));
  console.log(title);
  console.log("=".repeat(60));
}

async function main() {
  await new Promise((r) => ws.once("open", r));
  console.log("Connected to CDP");

  // 1) Runtime errors and warnings
  logSection("RUNTIME EXCEPTIONS (uncaught)");
  const exceptions = await send("Runtime.exceptionThrown", {}, { subscribe: true }).catch(() => null);
  // For one-off we use exceptionInfo on each exception
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.method === "Runtime.exceptionThrown") {
      const e = msg.params.exceptionDetails;
      console.log("EXCEPTION:", e.text || e.exception?.description);
      if (e.stackTrace?.callFrames?.length) {
        const f = e.stackTrace.callFrames[0];
        console.log("  at", f.url + ":" + f.lineNumber + ":" + f.columnNumber, f.functionName || "<anon>");
      }
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const t = msg.params.type;
      if (t === "error" || t === "warning") {
        const text = (msg.params.args || []).map(a => a.value ?? a.description ?? "").join(" ");
        console.log("[" + t.toUpperCase() + "]", text.slice(0, 300));
      }
    }
  });
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Network.enable");

  // 2) Network — failed requests
  let networkFails = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.method === "Network.loadingFailed") {
      networkFails.push(msg.params);
    }
    if (msg.method === "Network.responseReceived") {
      const r = msg.params.response;
      if (r.status >= 400) {
        console.log("HTTP", r.status, r.url);
      }
    }
  });

  // 3) Page load + snapshot
  logSection("RELOAD + WAIT");
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 5000));

  // 4) DOM snapshot — what is actually rendered
  logSection("RENDERED DOM (root tree)");
  const { root } = await send("DOM.getDocument", { depth: 6, pierce: true });

  function walk(node, depth = 0) {
    if (!node) return;
    const indent = "  ".repeat(depth);
    if (node.nodeType === 1) {
      const attrs = [];
      if (node.attributes) {
        for (let i = 0; i < node.attributes.length; i += 2) {
          attrs.push(node.attributes[i] + "=" + JSON.stringify(node.attributes[i + 1]).slice(0, 50));
        }
      }
      const id = node.attributes?.find ? null : null;
      const nodeId = node.backendNodeId || node.nodeId;
      const tag = node.nodeName.toLowerCase();
      const a = attrs.length ? " " + attrs.slice(0, 4).join(" ") : "";
      console.log(indent + "<" + tag + a + ">");
      if (node.children) {
        for (const c of node.children) walk(c, depth + 1);
      }
    } else if (node.nodeType === 3) {
      const t = (node.nodeValue || "").trim();
      if (t) console.log(indent + JSON.stringify(t).slice(0, 120));
    }
  }

  // Just the first 3 levels of body to keep output readable
  function walkShallow(node, depth = 0, max = 3) {
    if (!node || depth > max) return;
    const indent = "  ".repeat(depth);
    if (node.nodeType === 1) {
      const attrs = [];
      if (node.attributes) {
        for (let i = 0; i < node.attributes.length; i += 2) {
          attrs.push(node.attributes[i]);
        }
      }
      const tag = node.nodeName.toLowerCase();
      const a = attrs.length ? " [" + attrs.slice(0, 5).join(",") + "]" : "";
      console.log(indent + "<" + tag + a + ">");
      if (node.children && depth < max) {
        for (const c of node.children) walkShallow(c, depth + 1, max);
      }
    } else if (node.nodeType === 3) {
      const t = (node.nodeValue || "").trim();
      if (t) console.log(indent + JSON.stringify(t).slice(0, 80));
    }
  }

  // Find the body and dump it
  function findBody(node) {
    if (!node) return null;
    if (node.nodeName && node.nodeName.toLowerCase() === "body") return node;
    if (node.children) {
      for (const c of node.children) {
        const f = findBody(c);
        if (f) return f;
      }
    }
    return null;
  }

  const body = findBody(root);
  walkShallow(body, 0, 5);

  // 5) Layout — check for overflow / off-screen elements
  logSection("OVERFLOW SCAN (elements wider than viewport)");
  const layout = await send("DOM.getDocument", { depth: -1, pierce: true });
  const { result } = await send("Runtime.evaluate", {
    expression: `(() => {
      const vw = document.documentElement.clientWidth;
      const offenders = [];
      document.querySelectorAll("*").forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.right > vw + 1 || r.left < -1) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className && typeof el.className === "string" ? el.className.slice(0, 60) : ""),
            id: el.id || "",
            left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
            text: (el.textContent || "").trim().slice(0, 50)
          });
        }
      });
      return { vw, count: offenders.length, sample: offenders.slice(0, 15) };
    })()`,
    returnByValue: true
  });
  console.log("viewport:", result.value.vw, "px");
  console.log("overflowing elements:", result.value.count);
  console.log("sample:", JSON.stringify(result.value.sample, null, 2));

  // 6) Accessibility audit
  logSection("ACCESSIBILITY SCAN (missing labels/aria/alt)");
  const a11y = await send("Runtime.evaluate", {
    expression: `(() => {
      const issues = [];
      // buttons without accessible name
      document.querySelectorAll("button").forEach((b, i) => {
        const txt = (b.textContent || "").trim();
        const aria = b.getAttribute("aria-label");
        const title = b.getAttribute("title");
        if (!txt && !aria && !title) {
          issues.push({ kind: "button-no-name", html: b.outerHTML.slice(0, 200) });
        }
      });
      // inputs without label
      document.querySelectorAll("input, select, textarea").forEach((inp) => {
        const type = (inp.getAttribute("type") || "").toLowerCase();
        if (type === "hidden" || type === "submit" || type === "button") return;
        const id = inp.id;
        const aria = inp.getAttribute("aria-label") || inp.getAttribute("aria-labelledby");
        const placeholder = inp.getAttribute("placeholder");
        const labels = id ? document.querySelectorAll(\`label[for="\${id}"]\`) : [];
        const wrapped = inp.closest("label");
        if (!aria && labels.length === 0 && !wrapped) {
          issues.push({ kind: "input-no-label", type, name: inp.getAttribute("name"), placeholder, html: inp.outerHTML.slice(0, 200) });
        }
      });
      // images without alt
      document.querySelectorAll("img").forEach((img) => {
        if (!img.hasAttribute("alt")) {
          issues.push({ kind: "img-no-alt", src: img.getAttribute("src")?.slice(0, 80) });
        }
      });
      // form inputs missing autocomplete
      document.querySelectorAll("input[type=email], input[type=tel], input[name=name], input[name=email]").forEach((inp) => {
        if (!inp.getAttribute("autocomplete")) {
          issues.push({ kind: "input-no-autocomplete", type: inp.getAttribute("type"), name: inp.getAttribute("name") });
        }
      });
      return issues.slice(0, 30);
    })()`,
    returnByValue: true
  });
  console.log("a11y issues:", a11y.result.value.length);
  for (const i of a11y.result.value) {
    console.log("  -", i.kind, JSON.stringify(i).slice(0, 160));
  }

  // 7) Click-through to cart drawer
  logSection("CART BUTTON STATE");
  const cartBtn = await send("Runtime.evaluate", {
    expression: `(() => {
      const b = document.querySelector("button[aria-label='Notifications']")?.parentElement?.previousElementSibling;
      // fallback: find cart by shopping cart icon
      const all = Array.from(document.querySelectorAll("button"));
      const cart = all.find(b => b.querySelector("svg") && b.className.includes("p-2.5"));
      if (!cart) return { found: false };
      const r = cart.getBoundingClientRect();
      return { found: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: cart.textContent.trim() };
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(cartBtn.result.value));

  // 8) Tap the Add button on the first menu item without variations
  logSection("CLICK FIRST 'ADD' BUTTON");
  const addBtn = await send("Runtime.evaluate", {
    expression: `(() => {
      const addBtns = Array.from(document.querySelectorAll("button")).filter(b => b.textContent.trim() === "Add");
      if (addBtns.length === 0) return { found: false };
      const b = addBtns[0];
      const r = b.getBoundingClientRect();
      return { found: true, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), count: addBtns.length };
    })()`,
    returnByValue: true
  });
  console.log("Add button:", JSON.stringify(addBtn.result.value));

  if (addBtn.result.value.found) {
    // Use Input.dispatchMouseEvent to click
    const { x, y } = addBtn.result.value;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 1500));

    // Check if page went white / is there any content?
    const afterClick = await send("Runtime.evaluate", {
      expression: `(() => {
        return {
          url: location.href,
          title: document.title,
          bodyText: (document.body.textContent || "").trim().slice(0, 200),
          bodyChildren: document.body.children.length,
          bodyRect: document.body.getBoundingClientRect().toJSON(),
          mainExists: !!document.querySelector("main"),
          rootContent: document.getElementById("root")?.innerHTML?.length || 0
        };
      })()`,
      returnByValue: true
    });
    console.log("After click:", JSON.stringify(afterClick.result.value, null, 2));

    // Console errors after the click
    logSection("CONSOLE MESSAGES (errors/warnings after click)");
    // already streaming above
  }

  // 9) Performance / network
  logSection("NETWORK FAILURES");
  console.log("failed requests count:", networkFails.length);
  for (const f of networkFails.slice(0, 10)) {
    console.log("  -", f.errorText, f.requestId);
  }

  // 10) Take a screenshot
  logSection("SCREENSHOT");
  const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
  const fs = require("fs");
  const path = require("path");
  const tmpDir = "C:\\Users\\c\\AppData\\Local\\Temp\\opencode";
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "savory_live.jpg"), Buffer.from(shot.data, "base64"));
  console.log("saved screenshot to " + path.join(tmpDir, "savory_live.jpg"));

  ws.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});