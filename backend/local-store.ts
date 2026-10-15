import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

type DocumentData = Record<string, any>;
type TimestampJSON = { seconds: number; nanoseconds: number };
type WriteOperation = { kind: "set" | "update" | "create" | "delete"; ref: LocalDocumentReference; data?: DocumentData; merge?: boolean };
type StoredRow = { path: string; collection_path: string; id: string; data: string; revision: number };
type Filter = { field: string; op: string; value: any };
type Ordering = { field: string; direction: "asc" | "desc" };
export type LocalChange = { paths: string[]; collections: string[]; committedAt: string };
export type ExportedDocument = { path: string; data: DocumentData };
const DELETE_FIELD = Symbol("deleteField");

function storeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function validatePath(input: string, isDocument: boolean): string {
  if (typeof input !== "string" || !input || input.length > 6000 || input !== input.trim() || input.split("/").some(part => !part || [".", "..", "__proto__", "prototype", "constructor"].includes(part) || /[\\\x00-\x1f]/.test(part))) {
    throw storeError("invalid-argument", "A non-empty document or collection path is required.");
  }
  if ((input.split("/").length % 2 === 0) !== isDocument) {
    throw storeError("invalid-argument", "The document or collection path has an invalid number of segments.");
  }
  return input;
}

function validateField(field: string): void {
  if (typeof field !== "string" || !field || field.length > 1500 || /[\x00-\x1f]/.test(field) || field.split(".").some(part => !part || ["__proto__", "prototype", "constructor"].includes(part))) {
    throw storeError("invalid-argument", "Invalid field path.");
  }
}

function validateValue(value: any, depth = 0, budget = { nodes: 0 }): void {
  if (depth > 30 || ++budget.nodes > 50_000) throw storeError("invalid-argument", "Document nesting or size is too large.");
  if (Array.isArray(value)) {
    for (const item of value) validateValue(item, depth + 1, budget);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      validateField(key);
      validateValue(item, depth + 1, budget);
    }
  }
}

function isRecord(value: any): value is DocumentData {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function timestampNow(): TimestampJSON {
  const now = Date.now();
  return { seconds: Math.floor(now / 1000), nanoseconds: (now % 1000) * 1_000_000 };
}

function timestampMillis(value: any): number | undefined {
  if (value instanceof Date) return value.getTime();
  // Legacy exports stored createdAt as ISO strings. Compare those with new
  // timestamp values without rewriting imported payment and order records.
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  if (!isRecord(value)) return undefined;
  const seconds = value.seconds ?? value._seconds;
  const nanoseconds = value.nanoseconds ?? value._nanoseconds ?? 0;
  if (typeof seconds !== "number" || typeof nanoseconds !== "number") return undefined;
  return seconds * 1000 + nanoseconds / 1_000_000;
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function equal(a: any, b: any): boolean {
  const aTime = timestampMillis(a);
  const bTime = timestampMillis(b);
  if (aTime !== undefined && bTime !== undefined) return aTime === bTime;
  return canonical(a) === canonical(b);
}

function compare(a: any, b: any): number {
  const aTime = timestampMillis(a);
  const bTime = timestampMillis(b);
  const left = aTime ?? a;
  const right = bTime ?? b;
  if (equal(left, right)) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  return left < right ? -1 : 1;
}

function fieldValue(data: DocumentData, field: string): any {
  return field.split(".").reduce((value, segment) => {
    return isRecord(value) && Object.hasOwn(value, segment) ? value[segment] : undefined;
  }, data);
}

function assignField(data: DocumentData, field: string, value: any): void {
  validateField(field);
  const segments = field.split(".");
  let current = data;
  for (const segment of segments.slice(0, -1)) {
    if (!isRecord(current[segment])) current[segment] = {};
    current = current[segment];
  }
  const last = segments[segments.length - 1];
  if (value === DELETE_FIELD) delete current[last];
  else current[last] = value;
}

function resolveValue(value: any, previous: any, now: TimestampJSON, merge: boolean): any {
  if (value === undefined) throw storeError("invalid-argument", "Undefined values cannot be stored.");
  if (value instanceof Date) {
    return { seconds: Math.floor(value.getTime() / 1000), nanoseconds: ((value.getTime() % 1000) + 1000) % 1000 * 1_000_000 };
  }
  if (Array.isArray(value)) {
    return value.map(item => {
      const resolved = resolveValue(item, undefined, now, false);
      if (resolved === DELETE_FIELD) throw storeError("invalid-argument", "deleteField cannot be used in arrays.");
      return resolved;
    });
  }
  if (!isRecord(value)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw storeError("invalid-argument", "Non-finite numbers cannot be stored.");
    if (["function", "symbol", "bigint"].includes(typeof value)) throw storeError("invalid-argument", "Unsupported document value.");
    return value;
  }
  if (Object.hasOwn(value, "__op")) {
    switch (value.__op) {
      case "increment": {
        if (typeof value.amount !== "number" || !Number.isFinite(value.amount)) throw storeError("invalid-argument", "increment requires a finite amount.");
        const result = (typeof previous === "number" ? previous : 0) + value.amount;
        if (!Number.isFinite(result)) throw storeError("invalid-argument", "Increment result is not finite.");
        return result;
      }
      case "serverTimestamp": return { ...now };
      case "deleteField": return DELETE_FIELD;
      case "arrayUnion": {
        const values = value.values ?? value.elements;
        if (!Array.isArray(values)) throw storeError("invalid-argument", "arrayUnion requires values.");
        const result = Array.isArray(previous) ? clone(previous) : [];
        for (const item of values) {
          const resolved = resolveValue(item, undefined, now, false);
          if (!result.some(existing => equal(existing, resolved))) result.push(resolved);
        }
        return result;
      }
      case "arrayRemove": {
        const values = value.values ?? value.elements;
        if (!Array.isArray(values)) throw storeError("invalid-argument", "arrayRemove requires values.");
        return (Array.isArray(previous) ? previous : []).filter(existing => !values.some(item => equal(existing, item)));
      }
      default: throw storeError("invalid-argument", "Unknown field transform.");
    }
  }
  const result: DocumentData = merge && isRecord(previous) ? clone(previous) : {};
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw storeError("invalid-argument", "Invalid document field.");
    const resolved = resolveValue(item, isRecord(previous) ? previous[key] : undefined, now, merge);
    if (resolved === DELETE_FIELD) delete result[key];
    else result[key] = resolved;
  }
  return result;
}

export class LocalDocumentSnapshot {
  readonly id: string;
  readonly exists: boolean;
  readonly ref: LocalDocumentReference;
  readonly revision: number;
  private readonly value: DocumentData | undefined;

  constructor(ref: LocalDocumentReference, value: DocumentData | undefined, revision: number) {
    this.ref = ref;
    this.id = ref.id;
    this.value = value;
    this.exists = value !== undefined;
    this.revision = revision;
  }

  data(): DocumentData | undefined { return clone(this.value); }
  get(field: string): any { return this.value ? clone(fieldValue(this.value, field)) : undefined; }
  get version(): number { return this.revision; }
}

export class LocalQuerySnapshot {
  readonly size: number;
  readonly empty: boolean;
  constructor(readonly docs: LocalDocumentSnapshot[]) {
    this.size = docs.length;
    this.empty = docs.length === 0;
  }
  forEach(callback: (snapshot: LocalDocumentSnapshot) => void): void { this.docs.forEach(callback); }
}

export class LocalQuery {
  constructor(readonly store: LocalStore, readonly path: string, readonly filters: Filter[] = [], readonly ordering: Ordering[] = [], readonly maximum?: number) {}
  where(field: string, op: string, value: any): LocalQuery {
    validateField(field);
    validateValue(value);
    if (!["==", "!=", "<", "<=", ">", ">=", "in", "not-in", "array-contains", "array-contains-any"].includes(op)) {
      throw storeError("invalid-argument", "Unsupported query operator.");
    }
    if (["in", "not-in", "array-contains-any"].includes(op) && !Array.isArray(value)) throw storeError("invalid-argument", "Query operator requires an array.");
    return new LocalQuery(this.store, this.path, [...this.filters, { field, op, value: clone(value) }], this.ordering, this.maximum);
  }
  orderBy(field: string, direction: "asc" | "desc" = "asc"): LocalQuery {
    validateField(field);
    if (!["asc", "desc"].includes(direction)) throw storeError("invalid-argument", "Invalid sort direction.");
    return new LocalQuery(this.store, this.path, this.filters, [...this.ordering, { field, direction }], this.maximum);
  }
  limit(maximum: number): LocalQuery {
    if (!Number.isInteger(maximum) || maximum < 1) throw storeError("invalid-argument", "Query limit must be a positive integer.");
    return new LocalQuery(this.store, this.path, this.filters, this.ordering, maximum);
  }
  async get(): Promise<LocalQuerySnapshot> { return this.store.readQuery(this).snapshot; }
}

export class LocalCollectionReference extends LocalQuery {
  readonly id: string;
  constructor(store: LocalStore, path: string) {
    super(store, validatePath(path, false));
    this.id = path.split("/").at(-1)!;
  }
  doc(id = randomUUID().replace(/-/g, "")): LocalDocumentReference { return this.store.doc(`${this.path}/${id}`); }
  async add(data: DocumentData): Promise<LocalDocumentReference> {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
}

export class LocalDocumentReference {
  readonly id: string;
  readonly parent: LocalCollectionReference;
  constructor(readonly store: LocalStore, readonly path: string) {
    validatePath(path, true);
    const parts = path.split("/");
    this.id = parts.at(-1)!;
    this.parent = store.collection(parts.slice(0, -1).join("/"));
  }
  collection(path: string): LocalCollectionReference { return this.store.collection(`${this.path}/${path}`); }
  async get(): Promise<LocalDocumentSnapshot> { return this.store.readDocument(this); }
  async set(data: DocumentData, options?: { merge?: boolean }): Promise<{ writeTime: TimestampJSON }> {
    return this.store.commit([{ kind: "set", ref: this, data, merge: options?.merge === true }])[0];
  }
  async update(data: DocumentData): Promise<{ writeTime: TimestampJSON }> { return this.store.commit([{ kind: "update", ref: this, data }])[0]; }
  async create(data: DocumentData): Promise<{ writeTime: TimestampJSON }> { return this.store.commit([{ kind: "create", ref: this, data }])[0]; }
  async delete(): Promise<{ writeTime: TimestampJSON }> { return this.store.commit([{ kind: "delete", ref: this }])[0]; }
}

export class LocalWriteBatch {
  protected readonly writes: WriteOperation[] = [];
  protected committed = false;
  constructor(readonly store: LocalStore) {}
  protected stage(operation: WriteOperation): this {
    if (this.committed) throw storeError("failed-precondition", "The batch has already committed.");
    if (operation.ref.store !== this.store) throw storeError("invalid-argument", "Document belongs to another store.");
    if (operation.kind !== "delete" && !isRecord(operation.data)) throw storeError("invalid-argument", "Document data must be an object.");
    this.writes.push({ ...operation, ...(operation.data ? { data: clone(operation.data) } : {}) });
    return this;
  }
  set(ref: LocalDocumentReference, data: DocumentData, options?: { merge?: boolean }): this { return this.stage({ kind: "set", ref, data, merge: options?.merge === true }); }
  update(ref: LocalDocumentReference, data: DocumentData): this { return this.stage({ kind: "update", ref, data }); }
  create(ref: LocalDocumentReference, data: DocumentData): this { return this.stage({ kind: "create", ref, data }); }
  delete(ref: LocalDocumentReference): this { return this.stage({ kind: "delete", ref }); }
  async commit(): Promise<{ writeTime: TimestampJSON }[]> {
    if (this.committed) throw storeError("failed-precondition", "The batch has already committed.");
    this.committed = true;
    return this.store.commit(this.writes);
  }
}

export class LocalTransaction extends LocalWriteBatch {
  readonly documentReads = new Map<string, number>();
  readonly queryReads = new Map<string, number>();
  private readonly documentCache = new Map<string, LocalDocumentSnapshot>();
  private readonly queryCache = new Map<LocalQuery, LocalQuerySnapshot>();
  async get(ref: LocalDocumentReference): Promise<LocalDocumentSnapshot>;
  async get(query: LocalQuery): Promise<LocalQuerySnapshot>;
  async get(target: LocalDocumentReference | LocalQuery): Promise<LocalDocumentSnapshot | LocalQuerySnapshot> {
    if (this.committed) throw storeError("failed-precondition", "The transaction has already committed.");
    if (target.store !== this.store) throw storeError("invalid-argument", "Reference belongs to another store.");
    if (this.writes.length) throw storeError("failed-precondition", "Read documents before staging transaction writes.");
    if (target instanceof LocalDocumentReference) {
      if (!this.documentCache.has(target.path)) {
        const snapshot = this.store.readDocument(target);
        this.documentCache.set(target.path, snapshot);
        this.documentReads.set(target.path, snapshot.revision);
      }
      return this.documentCache.get(target.path)!;
    }
    if (!this.queryCache.has(target)) {
      const result = this.store.readQuery(target);
      const previousRevision = this.queryReads.get(target.path);
      if (previousRevision !== undefined && previousRevision !== result.revision) throw storeError("aborted", "Transaction query changed during reads.");
      this.queryCache.set(target, result.snapshot);
      this.queryReads.set(target.path, result.revision);
    }
    return this.queryCache.get(target)!;
  }
  async getAll(...refs: LocalDocumentReference[]): Promise<LocalDocumentSnapshot[]> { return Promise.all(refs.map(ref => this.get(ref))); }
  async commit(): Promise<{ writeTime: TimestampJSON }[]> {
    if (this.committed) throw storeError("failed-precondition", "The transaction has already committed.");
    this.committed = true;
    return this.store.commit(this.writes, this.documentReads, this.queryReads);
  }
}

/** Durable single-host document store. Async callbacks never retain a SQLite transaction. */
export class LocalStore {
  readonly filePath: string;
  private readonly sqlite: DatabaseSync;
  private readonly listeners = new Set<(change: LocalChange) => void>();
  private closed = false;

  constructor(filePath: string) {
    this.filePath = filePath === ":memory:" ? filePath : resolve(filePath);
    if (this.filePath !== ":memory:") mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(this.filePath);
    if (this.filePath !== ":memory:" && process.platform !== "win32") chmodSync(this.filePath, 0o600);
    this.sqlite.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS local_documents (
        path TEXT PRIMARY KEY, collection_path TEXT NOT NULL, id TEXT NOT NULL,
        data TEXT NOT NULL, revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS local_documents_collection ON local_documents(collection_path, id);
      CREATE TABLE IF NOT EXISTS local_document_revisions (path TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_collection_revisions (path TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS local_revision_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO local_revision_clock(id, value) VALUES (1, 0);
    `);
  }

  collection(path: string): LocalCollectionReference { return new LocalCollectionReference(this, path); }
  doc(path: string): LocalDocumentReference { return new LocalDocumentReference(this, path); }
  batch(): LocalWriteBatch { return new LocalWriteBatch(this); }
  async getAll(...refs: LocalDocumentReference[]): Promise<LocalDocumentSnapshot[]> { return Promise.all(refs.map(ref => ref.get())); }
  onChange(listener: (change: LocalChange) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  close(): void {
    if (this.closed) return;
    this.listeners.clear();
    this.sqlite.close();
    this.closed = true;
  }

  readDocument(ref: LocalDocumentReference): LocalDocumentSnapshot {
    const row = this.sqlite.prepare(`SELECT d.data, COALESCE(v.revision, 0) AS revision
      FROM (SELECT ? AS path) p LEFT JOIN local_documents d ON d.path=p.path
      LEFT JOIN local_document_revisions v ON v.path=p.path`).get(ref.path) as { data: string | null; revision: number };
    return new LocalDocumentSnapshot(ref, row.data === null ? undefined : JSON.parse(row.data), row.revision);
  }

  readQuery(query: LocalQuery): { snapshot: LocalQuerySnapshot; revision: number } {
    const docs: LocalDocumentSnapshot[] = [];
    const valueFor = (snapshot: LocalDocumentSnapshot, field: string) => field === "__name__" ? snapshot.id : snapshot.get(field);
    const matches = (snapshot: LocalDocumentSnapshot) => query.filters.every(({ field, op, value }) => {
      const current = valueFor(snapshot, field);
      if (current === undefined) return false;
      switch (op) {
        case "==": return equal(current, value);
        case "!=": return !equal(current, value);
        case "<": return compare(current, value) < 0;
        case "<=": return compare(current, value) <= 0;
        case ">": return compare(current, value) > 0;
        case ">=": return compare(current, value) >= 0;
        case "in": return value.some((item: any) => equal(current, item));
        case "not-in": return current !== null && value.every((item: any) => item !== null && !equal(current, item));
        case "array-contains": return Array.isArray(current) && current.some(item => equal(item, value));
        case "array-contains-any": return Array.isArray(current) && current.some(item => value.some((candidate: any) => equal(item, candidate)));
        default: return false;
      }
    });
    const sort = (a: LocalDocumentSnapshot, b: LocalDocumentSnapshot) => {
      for (const order of query.ordering) {
        const difference = compare(valueFor(a, order.field), valueFor(b, order.field));
        if (difference) return order.direction === "desc" ? -difference : difference;
      }
      return compare(a.id, b.id);
    };
    // A max heap retains only the requested best results when sorting. An
    // attacker cannot force every matching document into Node's heap by adding
    // an arbitrary filter/order to an otherwise bounded public API query.
    const keepOrdered = (snapshot: LocalDocumentSnapshot) => {
      const maximum = query.maximum;
      if (maximum === undefined) { docs.push(snapshot); return; }
      if (docs.length < maximum) {
        docs.push(snapshot);
        let index = docs.length - 1;
        while (index > 0) {
          const parent = Math.floor((index - 1) / 2);
          if (sort(docs[parent], docs[index]) >= 0) break;
          [docs[parent], docs[index]] = [docs[index], docs[parent]];
          index = parent;
        }
        return;
      }
      if (sort(snapshot, docs[0]) >= 0) return;
      docs[0] = snapshot;
      let index = 0;
      while (index * 2 + 1 < docs.length) {
        const left = index * 2 + 1;
        const right = left + 1;
        const larger = right < docs.length && sort(docs[right], docs[left]) > 0 ? right : left;
        if (sort(docs[index], docs[larger]) >= 0) break;
        [docs[index], docs[larger]] = [docs[larger], docs[index]];
        index = larger;
      }
    };
    let revision: number;
    this.sqlite.exec("BEGIN");
    try {
      revision = Number((this.sqlite.prepare("SELECT revision FROM local_collection_revisions WHERE path=?").get(query.path) as any)?.revision ?? 0);
      const rows = this.sqlite.prepare("SELECT * FROM local_documents WHERE collection_path=? ORDER BY id").iterate(query.path);
      for (const value of rows) {
        const row = value as StoredRow;
        const snapshot = new LocalDocumentSnapshot(this.doc(row.path), JSON.parse(row.data), row.revision);
        if (!matches(snapshot)) continue;
        if (query.ordering.length) {
          if (query.ordering.every(order => valueFor(snapshot, order.field) !== undefined)) keepOrdered(snapshot);
        } else {
          docs.push(snapshot);
          // SQLite finalizes the iterator on break, so the snapshot transaction
          // can close before another write without retaining an open statement.
          if (query.maximum !== undefined && docs.length >= query.maximum) break;
        }
      }
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    if (query.ordering.length) docs.sort(sort);
    return { snapshot: new LocalQuerySnapshot(docs), revision };
  }

  commit(writes: WriteOperation[], reads = new Map<string, number>(), queries = new Map<string, number>()): { writeTime: TimestampJSON }[] {
    const now = timestampNow();
    const paths = new Set<string>();
    const collections = new Set<string>();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const [path, expected] of reads) {
        const current = Number((this.sqlite.prepare("SELECT revision FROM local_document_revisions WHERE path=?").get(path) as any)?.revision ?? 0);
        if (current !== expected) throw storeError("aborted", "Transaction document changed during initialization.");
      }
      for (const [path, expected] of queries) {
        const current = Number((this.sqlite.prepare("SELECT revision FROM local_collection_revisions WHERE path=?").get(path) as any)?.revision ?? 0);
        if (current !== expected) throw storeError("aborted", "Transaction collection changed during initialization.");
      }
      for (const write of writes) {
        if (write.ref.store !== this) throw storeError("invalid-argument", "Document belongs to another store.");
        const existing = this.readDocument(write.ref);
        if (write.kind === "create" && existing.exists) throw storeError("already-exists", "Document already exists.");
        if (write.kind === "update" && !existing.exists) throw storeError("not-found", "Document does not exist.");
        this.sqlite.prepare("UPDATE local_revision_clock SET value=value+1 WHERE id=1").run();
        const revision = Number((this.sqlite.prepare("SELECT value FROM local_revision_clock WHERE id=1").get() as any).value);
        if (write.kind === "delete") {
          this.sqlite.prepare("DELETE FROM local_documents WHERE path=?").run(write.ref.path);
        } else {
          if (!isRecord(write.data)) throw storeError("invalid-argument", "Document data must be an object.");
          validateValue(write.data);
          const previous = existing.data();
          let data: DocumentData;
          if (write.kind === "update") {
            data = previous!;
            for (const [field, value] of Object.entries(write.data)) assignField(data, field, resolveValue(value, fieldValue(previous!, field), now, false));
          } else {
            data = resolveValue(write.data, previous, now, write.merge === true);
          }
          if (!isRecord(data)) throw storeError("invalid-argument", "Document data must be an object.");
          this.sqlite.prepare(`INSERT INTO local_documents(path, collection_path, id, data, revision) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET data=excluded.data, revision=excluded.revision`).run(write.ref.path, write.ref.parent.path, write.ref.id, JSON.stringify(data), revision);
        }
        this.sqlite.prepare(`INSERT INTO local_document_revisions(path, revision) VALUES (?, ?)
          ON CONFLICT(path) DO UPDATE SET revision=excluded.revision`).run(write.ref.path, revision);
        this.sqlite.prepare(`INSERT INTO local_collection_revisions(path, revision) VALUES (?, ?)
          ON CONFLICT(path) DO UPDATE SET revision=excluded.revision`).run(write.ref.parent.path, revision);
        paths.add(write.ref.path);
        collections.add(write.ref.parent.path);
      }
      this.sqlite.exec("COMMIT");
    } catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
    if (paths.size) {
      const change: LocalChange = { paths: [...paths], collections: [...collections], committedAt: new Date().toISOString() };
      for (const listener of this.listeners) {
        try { Promise.resolve(listener(change)).catch(() => {}); }
        catch { /* Observers cannot roll back a committed payment. */ }
      }
    }
    return writes.map(() => ({ writeTime: { ...now } }));
  }

  async runTransaction<T>(callback: (transaction: LocalTransaction) => Promise<T> | T, options?: { maxAttempts?: number }): Promise<T> {
    const maximum = options?.maxAttempts ?? 5;
    if (!Number.isInteger(maximum) || maximum < 1) throw storeError("invalid-argument", "Invalid maximum transaction attempts.");
    for (let attempt = 0; attempt < maximum; attempt++) {
      const transaction = new LocalTransaction(this);
      try {
        const result = await callback(transaction);
        await transaction.commit();
        return result;
      } catch (error: any) {
        if (error?.code !== "aborted" || attempt === maximum - 1) throw error;
        await new Promise(resolveRetry => setTimeout(resolveRetry, Math.min(2 ** attempt, 20)));
      }
    }
    throw storeError("aborted", "Transaction could not be committed.");
  }

  listCollections(): string[] {
    return (this.sqlite.prepare("SELECT DISTINCT collection_path FROM local_documents ORDER BY collection_path").all() as { collection_path: string }[]).map(row => row.collection_path);
  }
  currentRevision(): number {
    return Number((this.sqlite.prepare("SELECT value FROM local_revision_clock WHERE id=1").get() as any).value);
  }
  exportDocuments(): ExportedDocument[] {
    return (this.sqlite.prepare("SELECT path, data FROM local_documents ORDER BY path").all() as { path: string; data: string }[]).map(row => ({ path: row.path, data: JSON.parse(row.data) }));
  }
  async importDocuments(records: ExportedDocument[], options?: { overwrite?: boolean }): Promise<number> {
    if (!Array.isArray(records)) throw storeError("invalid-argument", "Import requires document records.");
    const batch = this.batch();
    for (const record of records) {
      const ref = this.doc(record.path);
      if (options?.overwrite === true) batch.set(ref, record.data);
      else batch.create(ref, record.data);
    }
    await batch.commit();
    return records.length;
  }
}

export function createLocalStore(filePath: string): LocalStore { return new LocalStore(filePath); }
