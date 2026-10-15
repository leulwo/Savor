import { onIdTokenChanged, type Auth } from 'firebase/auth';

/** The browser talks to the application's database API; credentials stay on the server. */
export type DocumentData = Record<string, any>;
export type WhereFilterOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains' | 'array-contains-any';
type Filter = { field: string; op: WhereFilterOp; value: unknown };
type Sort = { field: string; direction: 'asc' | 'desc' };
type Constraint = { type: 'filter'; filter: Filter } | { type: 'order'; order: Sort } | { type: 'limit'; count: number };
type Write = { type: 'set' | 'update' | 'delete'; path: string; data?: DocumentData; merge?: boolean };
type Preconditions = { path: string; version: number | null }[];
type ReadRequest = { path: string; kind: 'document' | 'collection'; filters: Filter[]; orders: Sort[]; limit?: number };
type ReadResponse = { id?: string; exists?: boolean; data?: DocumentData; version?: number | null; docs?: { id: string; path: string; data: DocumentData; version?: number }[] };

export class DatabaseError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

/** Preserves the Timestamp methods used by chat and staff screens. */
export class Timestamp {
  constructor(public seconds: number, public nanoseconds: number) {}
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromDate(date: Date) { return Timestamp.fromMillis(date.getTime()); }
  static fromMillis(value: number) {
    const seconds = Math.floor(value / 1000);
    return new Timestamp(seconds, Math.round((value - seconds * 1000) * 1e6));
  }
  toDate() { return new Date(this.toMillis()); }
  toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
  toJSON() { return { __type: 'timestamp', seconds: this.seconds, nanoseconds: this.nanoseconds }; }
}

function encode(value: any): any {
  if (value instanceof Date) return Timestamp.fromDate(value).toJSON();
  if (value instanceof Timestamp) return value.toJSON();
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

function decode(value: any): any {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const seconds = value.seconds ?? value._seconds;
    const nanoseconds = value.nanoseconds ?? value._nanoseconds ?? 0;
    if (typeof seconds === 'number' && (value.__type === 'timestamp' || typeof value.nanoseconds === 'number' || typeof value._nanoseconds === 'number')) {
      return new Timestamp(seconds, nanoseconds);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

export class DocumentReference<T extends DocumentData = DocumentData> {
  readonly type = 'document' as const;
  readonly id: string;
  constructor(public database: DatabaseClient, public path: string) { this.id = path.split('/').at(-1)!; }
}

export class CollectionReference<T extends DocumentData = DocumentData> {
  readonly type = 'collection' as const;
  readonly id: string;
  constructor(public database: DatabaseClient, public path: string) { this.id = path.split('/').at(-1)!; }
}

export class Query<T extends DocumentData = DocumentData> {
  readonly type = 'query' as const;
  constructor(public database: DatabaseClient, public path: string, public constraints: Constraint[] = []) {}
}

export class DocumentSnapshot<T extends DocumentData = DocumentData> {
  readonly id: string;
  readonly metadata = { fromCache: false, hasPendingWrites: false };
  constructor(public ref: DocumentReference<T>, private value: T | undefined, public version: number | null = null) { this.id = ref.id; }
  exists(): this is QueryDocumentSnapshot<T> { return this.value !== undefined; }
  data(): T | undefined { return this.value; }
  get(field: string): any { return field.split('.').reduce((value, key) => value?.[key], this.value); }
}

export class QueryDocumentSnapshot<T extends DocumentData = DocumentData> extends DocumentSnapshot<T> {
  override data(): T { return super.data()!; }
}

export class QuerySnapshot<T extends DocumentData = DocumentData> {
  readonly size: number;
  readonly empty: boolean;
  constructor(public docs: QueryDocumentSnapshot<T>[]) { this.size = docs.length; this.empty = docs.length === 0; }
  forEach(callback: (document: QueryDocumentSnapshot<T>) => void) { this.docs.forEach(callback); }
}

type Target = DocumentReference | CollectionReference | Query;
type Snapshot = DocumentSnapshot | QuerySnapshot;
type Listener = { next: (snapshot: any) => void; error?: (error: DatabaseError) => void };
type Subscription = { target: Target; listeners: Set<Listener>; snapshot?: Snapshot; fingerprint?: string; loading: boolean; dirty: boolean; timer?: ReturnType<typeof setTimeout> };

function readRequest(target: Target): ReadRequest {
  const result: ReadRequest = { path: target.path, kind: target.type === 'document' ? 'document' : 'collection', filters: [], orders: [] };
  if (target instanceof Query) for (const constraint of target.constraints) {
    if (constraint.type === 'filter') result.filters.push(constraint.filter);
    if (constraint.type === 'order') result.orders.push(constraint.order);
    if (constraint.type === 'limit') result.limit = constraint.count;
  }
  return result;
}

export class DatabaseClient {
  readonly type = 'local-database' as const;
  private subscriptions = new Map<string, Subscription>();
  private stream?: AbortController;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pollingTimer?: ReturnType<typeof setInterval>;
  private stopAuthWatch?: () => void;
  private generation = 0;
  private retryDelay = 1000;
  private revision: number | undefined;

  constructor(private auth: Auth, private baseUrl = '/api/database') {
    // Custom clients must not forward Firebase credentials to another origin.
    if (!/^\/api\/[A-Za-z0-9_/-]+$/.test(baseUrl) || baseUrl.split('/').some(part => part === '.' || part === '..')) {
      throw new DatabaseError('UNSAFE_API_URL', 'The database must use this website’s API.');
    }
  }

  private async authenticatedFetch(path: string, options: RequestInit = {}): Promise<Response> {
    await this.auth.authStateReady();
    const user = this.auth.currentUser;
    const uid = user?.uid ?? null;
    const headers = new Headers(options.headers);
    headers.set('Content-Type', 'application/json');
    try {
      if (user) headers.set('Authorization', `Bearer ${await user.getIdToken()}`);
    } catch { throw new DatabaseError('AUTH_SESSION_EXPIRED', 'Your sign-in session expired. Sign in again to continue.'); }
    const ensureCurrentUser = () => {
      if ((this.auth.currentUser?.uid ?? null) !== uid) throw new DatabaseError('AUTH_USER_CHANGED', 'Your sign-in session changed. Please try again.');
    };
    ensureCurrentUser();
    let response = await fetch(`${this.baseUrl}${path}`, { ...options, headers, redirect: 'error', credentials: 'same-origin', cache: 'no-store' });
    ensureCurrentUser();
    if (response.status === 401 && user) {
      try { headers.set('Authorization', `Bearer ${await user.getIdToken(true)}`); }
      catch { throw new DatabaseError('AUTH_SESSION_EXPIRED', 'Your sign-in session expired. Sign in again to continue.'); }
      ensureCurrentUser();
      response = await fetch(`${this.baseUrl}${path}`, { ...options, headers, redirect: 'error', credentials: 'same-origin', cache: 'no-store' });
      ensureCurrentUser();
    }
    return response;
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      await this.auth.authStateReady();
      const responseUid = this.auth.currentUser?.uid ?? null;
      const response = await this.authenticatedFetch(path, { method: 'POST', body: JSON.stringify(encode(body)), signal: controller.signal });
      if ((this.auth.currentUser?.uid ?? null) !== responseUid) throw new DatabaseError('AUTH_USER_CHANGED', 'Your sign-in session changed. Please try again.');
      let data: any;
      try { data = await response.json(); }
      catch { throw new DatabaseError('DATABASE_INVALID_RESPONSE', 'The database server returned an unreadable response. Please try again.'); }
      if ((this.auth.currentUser?.uid ?? null) !== responseUid) throw new DatabaseError('AUTH_USER_CHANGED', 'Your sign-in session changed. Please try again.');
      if (!response.ok || data?.success === false) {
        const message = typeof data?.error === 'string' ? data.error : typeof data?.message === 'string' ? data.message : 'The database request could not be completed.';
        throw new DatabaseError(String(data?.code || (response.status === 401 ? 'AUTH_SESSION_EXPIRED' : response.status === 403 ? 'permission-denied' : 'DATABASE_REQUEST_FAILED')), message);
      }
      return data as T;
    } catch (error) {
      if (error instanceof DatabaseError) throw error;
      throw new DatabaseError(controller.signal.aborted ? 'DATABASE_TIMEOUT' : 'DATABASE_UNAVAILABLE', controller.signal.aborted ? 'The database took too long to respond. Please try again.' : 'Could not connect to the database. Check your connection and try again.');
    } finally { clearTimeout(timeout); }
  }

  async read(target: Target): Promise<Snapshot> {
    const result = await this.request<ReadResponse>('/query', readRequest(target));
    if (target instanceof DocumentReference) return new DocumentSnapshot(target, result.exists ? decode(result.data || {}) : undefined, result.version ?? null);
    return new QuerySnapshot((result.docs || []).map(item => new QueryDocumentSnapshot(new DocumentReference(this, item.path || `${target.path}/${item.id}`), decode(item.data), item.version ?? null)));
  }

  async commit(writes: Write[], preconditions?: Preconditions): Promise<void> {
    if (!writes.length) return;
    const result = await this.request<{ revision?: number }>('/commit', { writes, ...(preconditions ? { preconditions } : {}) });
    if (typeof result.revision === 'number') this.revision = result.revision;
    this.invalidate();
  }

  subscribe(target: Target, next: Listener['next'], error?: Listener['error']): () => void {
    const key = JSON.stringify(encode(readRequest(target)));
    let entry = this.subscriptions.get(key);
    if (!entry) {
      entry = { target, listeners: new Set(), loading: false, dirty: false };
      this.subscriptions.set(key, entry);
    }
    const listener = { next, error };
    entry.listeners.add(listener);
    if (entry.snapshot) queueMicrotask(() => { if (entry!.listeners.has(listener)) this.deliver(listener, entry!.snapshot!); });
    else if (!entry.loading) void this.refresh(entry);
    this.startWatching();
    return () => {
      entry!.listeners.delete(listener);
      if (!entry!.listeners.size) {
        if (entry!.timer) clearTimeout(entry!.timer);
        this.subscriptions.delete(key);
      }
      if (!this.subscriptions.size) this.stopWatching();
    };
  }

  private deliver(listener: Listener, snapshot: Snapshot) {
    try { listener.next(snapshot); } catch (error) { console.error('Database snapshot listener failed:', error); }
  }

  private async refresh(entry: Subscription) {
    if (!entry.listeners.size) return;
    if (entry.loading) { entry.dirty = true; return; }
    entry.loading = true;
    entry.dirty = false;
    const generation = this.generation;
    try {
      const snapshot = await this.read(entry.target);
      if (generation !== this.generation || !entry.listeners.size) return;
      const fingerprint = JSON.stringify(snapshot instanceof QuerySnapshot ? snapshot.docs.map(item => [item.id, item.version, item.data()]) : [snapshot.exists(), snapshot.version, snapshot.data()]);
      entry.snapshot = snapshot;
      if (entry.fingerprint !== fingerprint) {
        entry.fingerprint = fingerprint;
        entry.listeners.forEach(listener => this.deliver(listener, snapshot));
      }
    } catch (error) {
      if (generation === this.generation && entry.listeners.size) {
        const failure = error instanceof DatabaseError ? error : new DatabaseError('DATABASE_UNAVAILABLE', 'Could not refresh the database.');
        entry.listeners.forEach(listener => { try { listener.error?.(failure); } catch {} });
      }
    } finally {
      entry.loading = false;
      if (entry.dirty && entry.listeners.size) this.scheduleRefresh(entry);
    }
  }

  private scheduleRefresh(entry: Subscription) {
    if (entry.timer || !entry.listeners.size) return;
    entry.timer = setTimeout(() => { entry.timer = undefined; void this.refresh(entry); }, 50);
  }

  private invalidate() { this.subscriptions.forEach(entry => this.scheduleRefresh(entry)); }

  private startWatching() {
    if (this.stopAuthWatch) return;
    let previousUid = this.auth.currentUser?.uid ?? null;
    this.stopAuthWatch = onIdTokenChanged(this.auth, user => {
      const uid = user?.uid ?? null;
      if (uid !== previousUid) {
        previousUid = uid;
        this.generation++;
        this.revision = undefined;
        this.subscriptions.forEach(entry => {
          entry.snapshot = undefined;
          entry.fingerprint = undefined;
          entry.dirty = true;
          // Remove any previous customer's data immediately while the new session loads.
          const empty = entry.target instanceof DocumentReference ? new DocumentSnapshot(entry.target, undefined) : new QuerySnapshot([]);
          entry.listeners.forEach(listener => this.deliver(listener, empty));
        });
        this.invalidate();
      }
      this.restartStream();
    });
    // Polling keeps updates working through proxy buffering and interrupted SSE connections.
    this.pollingTimer = setInterval(() => this.invalidate(), 15000);
  }

  private restartStream() {
    this.stream?.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (!this.subscriptions.size) return;
    this.stream = new AbortController();
    void this.connectStream(this.stream);
  }

  private async connectStream(controller: AbortController) {
    const generation = this.generation;
    try {
      const response = await this.authenticatedFetch('/events', { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Live updates unavailable');
      this.retryDelay = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const text = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!text || generation !== this.generation) continue;
          try {
            const data = JSON.parse(text);
            if (typeof data.revision === 'number' && data.revision !== this.revision) { this.revision = data.revision; this.invalidate(); }
          } catch { /* Heartbeat messages carry no database data. */ }
        }
      }
    } catch { /* Polling remains active while the stream reconnects. */ }
    finally {
      if (!controller.signal.aborted && this.subscriptions.size && generation === this.generation) {
        this.reconnectTimer = setTimeout(() => this.restartStream(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
      }
    }
  }

  private stopWatching() {
    this.stream?.abort();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollingTimer) clearInterval(this.pollingTimer);
    this.stopAuthWatch?.();
    this.stopAuthWatch = undefined;
    this.reconnectTimer = undefined;
    this.pollingTimer = undefined;
    this.stream = undefined;
    this.generation++;
  }
}

export function createDatabaseClient(auth: Auth, baseUrl?: string) { return new DatabaseClient(auth, baseUrl); }

function buildPath(parent: DatabaseClient | DocumentReference | CollectionReference, parts: string[]): string {
  const prefix = parent instanceof DatabaseClient ? [] : [parent.path];
  const path = [...prefix, ...parts].join('/');
  if (!path || path.split('/').some(segment => !segment)) throw new DatabaseError('invalid-argument', 'A database path cannot be empty.');
  return path;
}
function clientOf(parent: DatabaseClient | DocumentReference | CollectionReference) { return parent instanceof DatabaseClient ? parent : parent.database; }
export function collection<T extends DocumentData = DocumentData>(parent: DatabaseClient | DocumentReference | CollectionReference, ...parts: string[]): CollectionReference<T> {
  const path = buildPath(parent, parts);
  if (path.split('/').length % 2 !== 1) throw new DatabaseError('invalid-argument', 'Expected a collection path.');
  return new CollectionReference<T>(clientOf(parent), path);
}
export function doc<T extends DocumentData = DocumentData>(parent: DatabaseClient | DocumentReference | CollectionReference, ...parts: string[]): DocumentReference<T> {
  if (parent instanceof CollectionReference && !parts.length) parts = [crypto.randomUUID().replaceAll('-', '')];
  const path = buildPath(parent, parts);
  if (path.split('/').length % 2 !== 0) throw new DatabaseError('invalid-argument', 'Expected a document path.');
  return new DocumentReference<T>(clientOf(parent), path);
}
export function where(field: string, op: WhereFilterOp, value: unknown): Constraint { return { type: 'filter', filter: { field, op, value } }; }
export function orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): Constraint { return { type: 'order', order: { field, direction } }; }
export function limit(count: number): Constraint {
  if (!Number.isInteger(count) || count < 1) throw new DatabaseError('invalid-argument', 'Query limit must be a positive integer.');
  return { type: 'limit', count };
}
export function query<T extends DocumentData = DocumentData>(target: CollectionReference<T> | Query<T>, ...constraints: Constraint[]): Query<T> {
  return new Query<T>(target.database, target.path, [...(target instanceof Query ? target.constraints : []), ...constraints]);
}
export async function getDoc<T extends DocumentData>(reference: DocumentReference<T>): Promise<DocumentSnapshot<T>> { return reference.database.read(reference) as Promise<DocumentSnapshot<T>>; }
export async function getDocs<T extends DocumentData>(reference: CollectionReference<T> | Query<T>): Promise<QuerySnapshot<T>> { return reference.database.read(reference) as Promise<QuerySnapshot<T>>; }
export function onSnapshot<T extends DocumentData>(reference: DocumentReference<T>, next: (snapshot: DocumentSnapshot<T>) => void, error?: (error: DatabaseError) => void): () => void;
export function onSnapshot<T extends DocumentData>(reference: CollectionReference<T> | Query<T>, next: (snapshot: QuerySnapshot<T>) => void, error?: (error: DatabaseError) => void): () => void;
export function onSnapshot(reference: Target, next: Listener['next'], error?: Listener['error']): () => void { return reference.database.subscribe(reference, next, error); }
export function serverTimestamp() { return { __op: 'serverTimestamp' } as const; }
export function increment(amount: number) { return { __op: 'increment', amount } as const; }
export function deleteField() { return { __op: 'deleteField' } as const; }
export function setDoc(reference: DocumentReference, data: DocumentData, options?: { merge?: boolean }): Promise<void> { return reference.database.commit([{ type: 'set', path: reference.path, data, merge: options?.merge ?? false }]); }
export function updateDoc(reference: DocumentReference, data: DocumentData): Promise<void> { return reference.database.commit([{ type: 'update', path: reference.path, data }]); }
export function deleteDoc(reference: DocumentReference): Promise<void> { return reference.database.commit([{ type: 'delete', path: reference.path }]); }
export async function addDoc<T extends DocumentData>(reference: CollectionReference<T>, data: T): Promise<DocumentReference<T>> {
  const newDocument = doc<T>(reference);
  await setDoc(newDocument, data);
  return newDocument;
}
export function writeBatch(database: DatabaseClient) {
  const writes: Write[] = [];
  let committed = false;
  const add = (write: Write) => { if (committed) throw new DatabaseError('failed-precondition', 'This database batch was already committed.'); writes.push(write); return batch; };
  const batch = {
    set: (reference: DocumentReference, data: DocumentData, options?: { merge?: boolean }) => add({ type: 'set', path: reference.path, data, merge: options?.merge ?? false }),
    update: (reference: DocumentReference, data: DocumentData) => add({ type: 'update', path: reference.path, data }),
    delete: (reference: DocumentReference) => add({ type: 'delete', path: reference.path }),
    commit: async () => { if (committed) throw new DatabaseError('failed-precondition', 'This database batch was already committed.'); committed = true; await database.commit(writes); }
  };
  return batch;
}
