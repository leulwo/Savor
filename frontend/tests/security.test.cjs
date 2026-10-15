const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(relative, globals = {}, dependencies = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, URL, Headers, fetch, console, ...globals, require: name => {
    if (name in dependencies) return dependencies[name];
    throw new Error(`Unexpected dependency ${name}`);
  } });
  return module.exports;
}
const security = load('src/utils/security.ts');

test('checkout navigation accepts only hosted HTTPS Chapa checkout paths', () => {
  assert.equal(security.safeChapaCheckoutUrl('https://checkout.chapa.co/checkout/payment/test'), 'https://checkout.chapa.co/checkout/payment/test');
  assert.equal(security.safeChapaCheckoutUrl('https://checkout.chapa.co/checkout/test-payment/fixture_123'), 'https://checkout.chapa.co/checkout/test-payment/fixture_123');
  for (const value of [null, {}, 'javascript:alert(1)', 'data:text/html,test', '//checkout.chapa.co/test', 'http://checkout.chapa.co/test', 'https://checkout.chapa.co.evil.example/test', 'https://chapa.co@evil.example/test', 'https://evil.example@checkout.chapa.co/test', 'https://checkout.chapa.co:8080/test', 'https://checkout.chapa.co\\@evil.example/test', 'https://checkout.chapa.co/\ntest', 'https://api.chapa.co/checkout/test', 'https://chapa.co/', 'https://checkout.chapa.co/checkout/payment/test#fragment', 'https://checkout.chapa.co/checkout/payment/%2fother', 'https://checkout.chapa.co/' + 'x'.repeat(2048)]) {
    assert.equal(security.safeChapaCheckoutUrl(value), undefined, String(value));
  }
});

test('external receipt and tracking links cannot execute JavaScript', () => {
  assert.equal(security.safeHttpsUrl('https://tracking.example/order?id=123'), 'https://tracking.example/order?id=123');
  assert.equal(security.safeChapaReceiptUrl('https://chapa.link/payment-receipt/test'), 'https://chapa.link/payment-receipt/test');
  for (const value of ['javascript:alert(1)', 'https://chapa.link.evil.example/test', 'https://evil.example/test']) assert.equal(security.safeChapaReceiptUrl(value), undefined);
});

test('authenticated API paths reject cross-origin and normalized traversal destinations', () => {
  assert.equal(security.requireApiPath('/api/chapa/attempt/PAY-123?ref=test'), '/api/chapa/attempt/PAY-123?ref=test');
  for (const value of ['https://evil.example/api/test', '//evil.example/api/test', '/api/../../other', '/api/%2e%2e/%2e%2e/other', '/api\\evil.example', '/other', '/api/test#fragment', '/api/\ntest']) {
    assert.throws(() => security.requireApiPath(value), error => error.code === 'UNSAFE_API_URL', value);
  }
});

function authFetchSetup(fetchRequest, initialUser) {
  const auth = { currentUser: initialUser, authStateReady: async () => {} };
  const { createAuthenticatedFetch } = load('src/utils/authenticatedFetch.ts', {}, { './security': security });
  return { auth, request: createAuthenticatedFetch(auth, fetchRequest) };
}

test('authenticated fetch never reads a token or sends a request for an external URL', async () => {
  let calls = 0;
  const env = authFetchSetup(async () => { calls++; }, { uid: 'owner', getIdToken: async () => { calls++; return 'private-token'; } });
  await assert.rejects(env.request('https://attacker.example/api/test'), error => error.code === 'UNSAFE_API_URL');
  assert.equal(calls, 0);
});

test('authenticated fetch pins credentials to the API, blocks redirects, and refreshes once', async () => {
  const requests = [];
  const env = authFetchSetup(async (url, options) => {
    requests.push({ url, authorization: options.headers.get('Authorization'), redirect: options.redirect, credentials: options.credentials, cache: options.cache });
    return new Response('{}', { status: requests.length === 1 ? 401 : 200 });
  }, { uid: 'owner', getIdToken: async refresh => refresh ? 'refreshed' : 'original' });
  await env.request('/api/orders', { redirect: 'follow', credentials: 'include' });
  assert.deepEqual(requests, [
    { url: '/api/orders', authorization: 'Bearer original', redirect: 'error', credentials: 'same-origin', cache: 'no-store' },
    { url: '/api/orders', authorization: 'Bearer refreshed', redirect: 'error', credentials: 'same-origin', cache: 'no-store' }
  ]);
});

test('authenticated fetch fails closed when the account changes during token retrieval', async () => {
  let requests = 0;
  const env = authFetchSetup(async () => { requests++; }, { uid: 'old', getIdToken: async () => { env.auth.currentUser = { uid: 'new' }; return 'old-token'; } });
  await assert.rejects(env.request('/api/orders'), error => error.code === 'AUTH_USER_CHANGED');
  assert.equal(requests, 0);
});

test('authenticated fetch rejects an old response after an account switch', async () => {
  const env = authFetchSetup(async () => { env.auth.currentUser = null; return new Response('{}'); }, { uid: 'old', getIdToken: async () => 'token' });
  await assert.rejects(env.request('/api/orders'), error => error.code === 'AUTH_USER_CHANGED');
});

test('public requests cannot inherit an Authorization header from a previous session', async () => {
  let authorization;
  const env = authFetchSetup(async (url, options) => { authorization = options.headers.get('Authorization'); return new Response('{}'); }, null);
  await env.request('/api/settings', { headers: { Authorization: 'Bearer previous-account' } });
  assert.equal(authorization, null);
});

test('CSV export neutralizes formula cells, including headers and quoted delimiters', () => {
  const { buildCsv } = load('src/utils/exportUtils.ts');
  assert.equal(buildCsv([{ name: '=HYPERLINK("https://evil.example","Click")', total: -12, plus: ' +SUM(1,2)', at: '@SUM(1)', tab: '\t=1+1' }]), 'name,total,plus,at,tab\n"\'=HYPERLINK(""https://evil.example"",""Click"")",-12,"\' +SUM(1,2)",\'@SUM(1),\'\t=1+1');
  assert.equal(buildCsv([], [{ key: 'value', label: '=Danger,quote' }]), '"\'=Danger,quote"');
  assert.equal(buildCsv([{ name: 'Normal customer', amount: 12.5 }]), 'name,amount\nNormal customer,12.5');
});

test('XLSX export writes attacker strings as string cells, never formula objects', async () => {
  const rows = [];
  let downloads = 0;
  const { downloadXlsx } = load('src/utils/exportUtils.ts', {
    Blob, Uint8Array, setTimeout: callback => callback(),
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    document: { createElement: () => ({ click: () => downloads++ }), body: { appendChild() {}, removeChild() {} } }
  }, { exceljs: { Workbook: class {
    xlsx = { writeBuffer: async () => new Uint8Array([1, 2]) };
    addWorksheet(name) { assert.equal(name, 'Customer_Report'); return { addRow: row => rows.push(Array.from(row)), getColumn: () => ({}) }; }
  } } });
  await downloadXlsx('report.xlsx', [{ name: 'Customer/Report', rows: [{ name: '=HYPERLINK("test")', amount: 12.5 }] }]);
  assert.deepEqual(rows, [['name', 'amount'], ['=HYPERLINK("test")', 12.5]]);
  assert.equal(downloads, 1);
});

test('generated Excel workbooks round-trip formula-leading names as literal string cells', async () => {
  const ExcelJS = require('exceljs');
  // The source is evaluated in a VM; ExcelJS's Array checks expect rows from
  // its own realm. Production modules share one browser realm.
  class WorkbookBridge extends ExcelJS.Workbook {
    addWorksheet(...args) {
      const sheet = super.addWorksheet(...args);
      const addRow = sheet.addRow.bind(sheet);
      sheet.addRow = values => addRow(Array.from(values));
      return sheet;
    }
  }
  let output;
  const { downloadXlsx } = load('src/utils/exportUtils.ts', {
    Blob, Uint8Array, setTimeout: callback => callback(),
    URL: { createObjectURL: blob => { output = blob; return 'blob:test'; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }), body: { appendChild() {}, removeChild() {} } }
  }, { exceljs: { Workbook: WorkbookBridge } });
  await downloadXlsx('security-test.xlsx', [{ name: 'Customers', rows: [{ name: '=HYPERLINK("https://attacker.example")', amount: -12.5 }] }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await output.arrayBuffer()));
  const sheet = workbook.getWorksheet('Customers');
  assert.equal(sheet.getCell('A2').value, '=HYPERLINK("https://attacker.example")');
  assert.equal(sheet.getCell('A2').formula, undefined);
  assert.equal(sheet.getCell('B2').value, -12.5);
});

test('sign-out clears customer contact, address, cart, order, chat, and notification caches', () => {
  const { clearPrivateBrowserCache, notificationCacheKey } = load('src/utils/privateCache.ts');
  const values = new Map([['lastAuthUid', 'old'], ['lastCheckoutAddress', 'private address'], ['gourmet_cart', 'private cart'], ['activeOrderId', 'PAY-old'], ['savory_customer_name', 'Private name'], [notificationCacheKey('old'), 'private notifications'], ['theme', 'dark']]);
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index], removeItem: key => values.delete(key) };
  clearPrivateBrowserCache(storage);
  assert.deepEqual([...values.keys()], ['theme']);
  assert.notEqual(notificationCacheKey('old'), notificationCacheKey('new'));
  assert.equal(notificationCacheKey(null), null);
});

test('Vite authorizes only the configured application hostname', () => {
  const config = load('vite.config.ts', { __dirname: path.join(__dirname, '..'), process: { env: {} } }, {
    '@tailwindcss/vite': { default: () => ({}) }, '@vitejs/plugin-react': { default: () => ({}) }, path: { default: path },
    vite: { defineConfig: callback => callback, loadEnv: () => ({ APP_URL: 'https://specific-tunnel.trycloudflare.com', PRIVATE_TEST_KEY: 'not-public' }) }
  });
  const result = config.default({ mode: 'development' });
  assert.deepEqual(Array.from(result.server.allowedHosts), ['specific-tunnel.trycloudflare.com']);
  assert.equal(JSON.stringify(result.define).includes('not-public'), false);
});

test('legacy malicious reviews cannot render objects or unbounded ratings into the public menu', () => {
  const { normalizeReview } = load('src/utils/displayData.ts');
  const row = normalizeReview({ id: 'forged', customerName: { html: 'malformed' }, comment: ['malformed'], rating: Infinity, menuItemId: {}, userId: [], createdAt: {} }, 'actual-id');
  assert.equal(row.id, 'actual-id');
  assert.equal(row.customerName, 'Customer');
  assert.equal(row.comment, '');
  assert.equal(row.rating, 0);
  assert.equal(normalizeReview({ rating: 1000, comment: 'valid review' }, 'id').rating, 5);
});

test('legacy profile and reservation fields remain safe for string filters and React rendering', () => {
  const { normalizeUserProfile, normalizeReservation } = load('src/utils/displayData.ts');
  const profile = normalizeUserProfile({ uid: 'forged', displayName: {}, email: [], savedAddresses: { address: 'invalid' }, favoriteItems: [null, {}, 'menu-id'] }, 'verified-id');
  assert.equal(profile.uid, 'verified-id');
  assert.equal(profile.displayName.toLowerCase(), 'customer');
  assert.equal(profile.email, '');
  assert.equal(profile.savedAddresses.length, 0);
  assert.deepEqual(Array.from(profile.favoriteItems), ['menu-id']);
  const reservation = normalizeReservation({ id: 'forged', customerName: {}, customerEmail: [], date: [], time: {}, notes: {}, status: {}, partySize: {} }, 'actual-id');
  assert.equal(reservation.id, 'actual-id');
  assert.equal(reservation.customerName, 'Customer');
  assert.equal(reservation.notes, '');
  assert.equal(reservation.status, 'pending');
  assert.equal(reservation.partySize, 1);
});

test('receipt QR rendering stays local and login never silently reseeds role permissions', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
  const orders = fs.readFileSync(path.join(__dirname, '../src/components/OrderList.tsx'), 'utf8');
  const qr = fs.readFileSync(path.join(__dirname, '../src/components/ReceiptQrCode.tsx'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '../src/AdminPortal.tsx'), 'utf8');
  assert.equal(app.includes('api.qrserver.com'), false);
  assert.equal(orders.includes('api.qrserver.com'), false);
  assert.equal(qr.includes('toCanvas(canvas.current, value'), true);
  assert.equal(admin.includes('seedDefaultRoles'), false);
  const qrData = require('qrcode').create(JSON.stringify({ orderId: 'SECURITY-TEST', total: '12.50 ETB' }), { errorCorrectionLevel: 'M' });
  assert.ok(qrData.modules.size > 0);
});
