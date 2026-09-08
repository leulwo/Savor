const { spawn } = require('child_process');
const http = require('http');

async function getDebuggerUrl(port) {
  for (let i = 0; i < 30; i++) {
    try {
      const data = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/version`, res => {
          let raw = '';
          res.on('data', chunk => raw += chunk);
          res.on('end', () => resolve(raw));
        }).on('error', reject);
      });
      const json = JSON.parse(data);
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch (e) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error('Chrome remote debugging did not become ready');
}

async function run() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const port = 9222;
  const tempProfile = 'C:\\Users\\c\\.gemini\\antigravity-ide\\brain\\1ba93b31-17f8-424b-9280-91fecd560d70\\scratch\\chrome_profile';

  console.log('[TEST] Launching Chrome...');
  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ]);

  try {
    const wsUrl = await getDebuggerUrl(port);
    console.log('[TEST] Connected to Chrome CDP at:', wsUrl);

    const ws = new WebSocket(wsUrl);
    let id = 1;
    const callbacks = new Map();

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && callbacks.has(msg.id)) {
        callbacks.get(msg.id)(msg);
        callbacks.delete(msg.id);
      }
    };

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    function send(method, params = {}) {
      return new Promise((resolve) => {
        const msgId = id++;
        callbacks.set(msgId, resolve);
        ws.send(JSON.stringify({ id: msgId, method, params }));
      });
    }

    async function evalCode(expression) {
      const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return res.result?.result?.value;
    }

    console.log('[TEST] Navigating to http://localhost:3000...');
    await send('Page.enable');
    await send('Page.navigate', { url: 'http://localhost:3000' });

    // Wait for page to load
    await new Promise(r => setTimeout(r, 4000));

    const pageTitle = await evalCode('document.title');
    console.log('[TEST] Page loaded. Title:', pageTitle);

    // Wait for menu items to appear
    console.log('[TEST] Looking for menu items...');
    let menuCount = 0;
    for (let i = 0; i < 20; i++) {
      menuCount = await evalCode(`document.querySelectorAll('button').length`);
      if (menuCount > 5) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('[TEST] Buttons found on page:', menuCount);

    // Click on the first "Add" or cart button
    console.log('[TEST] Adding an item to cart...');
    const added = await evalCode(`
      (() => {
        const addButtons = Array.from(document.querySelectorAll('button')).filter(b => 
          b.textContent.includes('Add') || b.textContent.includes('+') || b.getAttribute('aria-label')?.includes('Add')
        );
        if (addButtons.length > 0) {
          addButtons[0].click();
          return true;
        }
        return false;
      })()
    `);
    console.log('[TEST] Item added to cart:', added);
    await new Promise(r => setTimeout(r, 1500));

    // Open Cart / Checkout
    console.log('[TEST] Opening cart / checkout...');
    const cartOpened = await evalCode(`
      (() => {
        const cartBtn = Array.from(document.querySelectorAll('button')).find(b => 
          b.textContent.includes('Cart') || b.textContent.includes('Checkout') || b.querySelector('svg')
        );
        if (cartBtn) {
          cartBtn.click();
          return true;
        }
        return false;
      })()
    `);
    console.log('[TEST] Cart opened:', cartOpened);
    await new Promise(r => setTimeout(r, 1500));

    // Look for Proceed to Checkout button if cart drawer is open
    await evalCode(`
      (() => {
        const proceedBtn = Array.from(document.querySelectorAll('button')).find(b => 
          b.textContent.toLowerCase().includes('proceed') || b.textContent.toLowerCase().includes('checkout')
        );
        if (proceedBtn) proceedBtn.click();
      })()
    `);
    await new Promise(r => setTimeout(r, 1500));

    // Fill in the checkout form
    console.log('[TEST] Filling in checkout form...');
    const formFilled = await evalCode(`
      (() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const textareas = Array.from(document.querySelectorAll('textarea'));
        
        for (const input of inputs) {
          const ph = (input.placeholder || '').toLowerCase();
          const name = (input.name || '').toLowerCase();
          const type = (input.type || '').toLowerCase();

          if (ph.includes('name') || name.includes('name')) {
            input.value = 'Abebe Kebede';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (ph.includes('email') || name.includes('email') || type === 'email') {
            input.value = 'abebe.kebede@gmail.com';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (ph.includes('phone') || name.includes('phone') || type === 'tel') {
            input.value = '0911223344';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (ph.includes('address') || name.includes('address') || ph.includes('location')) {
            input.value = 'Bole Medhanialem, Addis Ababa';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }

        for (const ta of textareas) {
          ta.value = 'Bole Medhanialem, Addis Ababa';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Select Chapa payment method if not already selected
        const chapaRadio = Array.from(document.querySelectorAll('button, div, label')).find(el => 
          el.textContent.includes('Chapa') || el.textContent.includes('Online')
        );
        if (chapaRadio) chapaRadio.click();

        return true;
      })()
    `);
    console.log('[TEST] Form filled:', formFilled);
    await new Promise(r => setTimeout(r, 1500));

    // Click "Pay with Chapa" / "Place Order"
    console.log('[TEST] Submitting order / clicking Pay...');
    const submitClicked = await evalCode(`
      (() => {
        const payBtn = Array.from(document.querySelectorAll('button')).find(b => 
          b.textContent.includes('Pay with Chapa') || 
          b.textContent.includes('Pay Online') || 
          b.textContent.includes('Place Order') ||
          (b.type === 'submit' && !b.disabled)
        );
        if (payBtn) {
          payBtn.click();
          return payBtn.textContent.trim();
        }
        return null;
      })()
    `);
    console.log('[TEST] Pay button clicked:', submitClicked);

    // Wait for redirect to Chapa checkout
    console.log('[TEST] Waiting for redirect to Chapa...');
    let finalUrl = '';
    for (let i = 0; i < 30; i++) {
      finalUrl = await evalCode('window.location.href');
      console.log(`[TEST] Current URL (${i}s):`, finalUrl);
      if (finalUrl && finalUrl.includes('chapa.co')) {
        console.log('🎉 [TEST PASSED] Successfully redirected to Chapa checkout URL:', finalUrl);
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    if (finalUrl && finalUrl.includes('chapa.co')) {
      console.log('=== TEST RESULT: CHAPA ONLINE PAYMENT INITIALIZATION SUCCESSFUL ===');
    } else {
      console.log('[TEST] Final URL was:', finalUrl);
    }

    ws.close();
  } catch (err) {
    console.error('[TEST ERROR]:', err);
  } finally {
    console.log('[TEST] Script complete.');
  }
}

run();
