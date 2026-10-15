const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../src/database.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup(fetchImpl, initialUser = null) {
  const listeners = new Set();
  const auth = { currentUser: initialUser, authStateReady: async () => {} };
  const module = { exports: {} };
  const timers = new Set();
  const intervals = new Set();
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: name => {
      assert.equal(name, 'firebase/auth');
      return { onIdTokenChanged: (unused, listener) => {
        listeners.add(listener);
        queueMicrotask(() => { if (listeners.has(listener)) listener(auth.currentUser); });
        return () => listeners.delete(listener);
      } };
    },
    fetch: fetchImpl, Headers, TextDecoder, AbortController, Date, console, crypto,
    queueMicrotask, setInterval: callback => { intervals.add(callback); return callback; }, clearInterval: callback => intervals.delete(callback),
    setTimeout: (callback, delay) => { const timer = setTimeout(callback, delay); timers.add(timer); return timer; },
    clearTimeout: timer => { clearTimeout(timer); timers.delete(timer); }
  });
  return {
    api: module.exports, auth, db: new module.exports.DatabaseClient(auth),
    poll() { intervals.forEach(callback => callback()); },
    changeUser(user) { auth.currentUser = user; listeners.forEach(listener => listener(user)); },
    dispose() { timers.forEach(clearTimeout); }
  };
}

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function user(uid) { return { uid, getIdToken: async refresh => `${uid}-${refresh ? 'fresh' : 'cached'}` }; }
function events(signal) {
  let close;
  const body = new ReadableStream({ start(controller) {
    close = () => { try { controller.close(); } catch {} };
    signal.addEventListener('abort', close, { once: true });
  } });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

test('document reads preserve missing documents, timestamp methods, and public access', async () => {
  const requests = [];
  const env = setup(async (url, options) => {
    requests.push([url, options]);
    return json(requests.length === 1 ? { id: 'first', exists: true, version: 4, data: { createdAt: { seconds: 10, nanoseconds: 500000000 }, nested: { value: 2 } } } : { id: 'missing', exists: false, version: null });
  });
  try {
    const snapshot = await env.api.getDoc(env.api.doc(env.db, 'menu', 'first'));
    assert.equal(snapshot.exists(), true);
    assert.equal(snapshot.version, 4);
    assert.equal(snapshot.data().createdAt.toMillis(), 10500);
    assert.equal(snapshot.get('nested.value'), 2);
    assert.equal(requests[0][1].headers.has('Authorization'), false);
    const missing = await env.api.getDoc(env.api.doc(env.db, 'menu', 'missing'));
    assert.equal(missing.exists(), false);
    assert.equal(missing.data(), undefined);
  } finally { env.dispose(); }
});

test('protected API retries an expired token once and preserves readable server errors', async () => {
  const tokens = [];
  const env = setup(async (url, options) => {
    tokens.push(options.headers.get('Authorization'));
    return tokens.length === 1 ? json({ error: 'Expired' }, 401) : json({ success: false, code: 'permission-denied', error: 'This record belongs to another customer.' }, 403);
  }, user('owner'));
  try {
    await assert.rejects(env.api.getDoc(env.api.doc(env.db, 'orders', 'private')), error => error.code === 'permission-denied' && error.message === 'This record belongs to another customer.');
    assert.deepEqual(tokens, ['Bearer owner-cached', 'Bearer owner-fresh']);
  } finally { env.dispose(); }
});

test('database clients reject remote credential destinations and disable redirects', async () => {
  let options;
  const env = setup(async (url, requestOptions) => { options = requestOptions; return json({ exists: false }); }, user('owner'));
  try {
    for (const baseUrl of ['https://attacker.example/api/database', '//attacker.example', '/api/../other', '/api/database?redirect=external']) {
      assert.throws(() => new env.api.DatabaseClient(env.auth, baseUrl), error => error.code === 'UNSAFE_API_URL');
    }
    await env.api.getDoc(env.api.doc(env.db, 'orders', 'private'));
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
  } finally { env.dispose(); }
});

test('batch writes use one atomic commit and send server transforms without resolving them locally', async () => {
  let body;
  const env = setup(async (url, options) => { assert.equal(url, '/api/database/commit'); body = JSON.parse(options.body); return json({ success: true, revision: 7 }); }, user('owner'));
  try {
    const batch = env.api.writeBatch(env.db);
    batch.set(env.api.doc(env.db, 'users', 'owner'), { count: env.api.increment(2), createdAt: env.api.serverTimestamp(), omitted: undefined }, { merge: true });
    batch.update(env.api.doc(env.db, 'carts', 'owner'), { obsolete: env.api.deleteField() });
    await batch.commit();
    assert.deepEqual(body.writes, [
      { type: 'set', path: 'users/owner', data: { count: { __op: 'increment', amount: 2 }, createdAt: { __op: 'serverTimestamp' } }, merge: true },
      { type: 'update', path: 'carts/owner', data: { obsolete: { __op: 'deleteField' } } }
    ]);
    await assert.rejects(batch.commit(), error => error.code === 'failed-precondition');
  } finally { env.dispose(); }
});

test('identical live queries share one request, and one listener can unsubscribe safely', async () => {
  let reads = 0;
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const env = setup(async (url, options) => {
    if (url.endsWith('/events')) return events(options.signal);
    reads++;
    await response;
    return json({ docs: [{ id: 'first', path: 'menu/first', version: 1, data: { name: 'Lunch' } }] });
  });
  try {
    const resultsA = [];
    const resultsB = [];
    const q = env.api.query(env.api.collection(env.db, 'menu'), env.api.where('active', '==', true), env.api.orderBy('name'), env.api.limit(10));
    const unsubA = env.api.onSnapshot(q, snap => resultsA.push(snap));
    const unsubB = env.api.onSnapshot(q, snap => resultsB.push(snap));
    unsubA();
    release();
    await sleep(100);
    assert.equal(reads, 1);
    assert.equal(resultsA.length, 0);
    assert.equal(resultsB[0].size, 1);
    assert.equal(resultsB[0].docs[0].data().name, 'Lunch');
    unsubB();
  } finally { env.dispose(); }
});

test('SSE revisions invalidate active queries and ignore repeated revisions', async () => {
  let stream;
  let reads = 0;
  const env = setup(async (url, options) => {
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      options.signal.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    reads++;
    return json({ docs: [{ id: 'first', path: 'menu/first', version: reads, data: { count: reads } }] });
  });
  try {
    const snapshots = [];
    const unsubscribe = env.api.onSnapshot(env.api.collection(env.db, 'menu'), snapshot => snapshots.push(snapshot));
    await sleep(20);
    stream.enqueue(new TextEncoder().encode('data: {"revision":2}\r'));
    stream.enqueue(new TextEncoder().encode('\n\r'));
    stream.enqueue(new TextEncoder().encode('\n'));
    await sleep(100);
    assert.equal(reads, 2);
    assert.equal(snapshots.at(-1).docs[0].data().count, 2);
    stream.enqueue(new TextEncoder().encode('data: {"revision":2}\n\n'));
    await sleep(80);
    assert.equal(reads, 2);
    unsubscribe();
  } finally { env.dispose(); }
});

test('polling refreshes queries when a proxy cannot stream live updates', async () => {
  let reads = 0;
  const env = setup(async url => {
    if (url.endsWith('/events')) return json({ error: 'Streaming temporarily unavailable' }, 503);
    reads++;
    return json({ docs: [{ id: 'first', path: 'menu/first', version: reads, data: { count: reads } }] });
  });
  try {
    const seen = [];
    const unsubscribe = env.api.onSnapshot(env.api.collection(env.db, 'menu'), snapshot => seen.push(snapshot));
    await sleep(20);
    env.poll();
    await sleep(100);
    assert.equal(reads, 2);
    assert.equal(seen.at(-1).docs[0].data().count, 2);
    unsubscribe();
  } finally { env.dispose(); }
});

test('changing users discards a former user response and clears cached private snapshots', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const tokens = [];
  const env = setup(async (url, options) => {
    if (url.endsWith('/events')) return events(options.signal);
    const token = options.headers.get('Authorization');
    tokens.push(token);
    if (tokens.length === 2) await delayed;
    return json({ docs: [{ id: token, path: `orders/${token}`, data: { owner: token } }] });
  }, user('first'));
  try {
    const seen = [];
    const unsubscribe = env.api.onSnapshot(env.api.collection(env.db, 'orders'), snap => seen.push(snap));
    await sleep(20);
    const formerUserRead = env.api.getDocs(env.api.collection(env.db, 'orders'));
    await sleep(10);
    env.changeUser(user('second'));
    assert.equal(seen.at(-1).empty, true);
    release();
    await assert.rejects(formerUserRead, error => error.code === 'AUTH_USER_CHANGED');
    await sleep(100);
    assert.equal(seen.at(-1).docs[0].data().owner, 'Bearer second-cached');
    assert.equal(tokens.at(-1), 'Bearer second-cached');
    unsubscribe();
  } finally { env.dispose(); }
});
