import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "../local-store";

test("store boundaries reject dangerous paths and imported prototype field paths", async () => {
  const db = createLocalStore(":memory:");
  try {
    for (const path of ["users/../orders/one", "users/__proto__", "users/evil\\path", "users/evil\u0000path"]) {
      assert.throws(() => db.doc(path), { code: "invalid-argument" });
    }
    const ref = db.doc("users/customer");
    await assert.rejects(ref.set(JSON.parse('{"constructor.prototype.polluted":true}')), { code: "invalid-argument" });
    assert.throws(() => db.collection("users").where("constructor.prototype", "==", true), { code: "invalid-argument" });
    let deep: any = "value";
    for (let index = 0; index < 35; index++) deep = { child: deep };
    await assert.rejects(ref.set({ deep }), { code: "invalid-argument" });
    assert.equal((await ref.get()).exists, false);
    assert.equal((Object.prototype as any).polluted, undefined);
  } finally { db.close(); }
});

test("documents survive restart and nested collections do not leak into parent queries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "savory-store-"));
  const path = join(dir, "app.sqlite");
  let db = createLocalStore(path);
  try {
    await db.collection("orders").doc("one").create({ amount: 75, paymentStatus: "pending" });
    await db.doc("orders/one/history/first").create({ status: "created" });
    db.close();
    db = createLocalStore(path);
    assert.equal((await db.doc("orders/one").get()).get("amount"), 75);
    assert.equal((await db.collection("orders").get()).size, 1);
    assert.equal((await db.doc("orders/one").collection("history").get()).size, 1);
    assert.deepEqual(db.listCollections(), ["orders", "orders/one/history"]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("create is atomic and a rejected batch rolls back all writes and notifications", async () => {
  const db = createLocalStore(":memory:");
  try {
    await db.doc("orders/existing").create({ paymentStatus: "completed" });
    let notifications = 0;
    db.onChange(() => { notifications++; });
    const batch = db.batch();
    batch.create(db.doc("orders/new"), { paymentStatus: "pending" });
    batch.create(db.doc("orders/existing"), { paymentStatus: "pending" });
    await assert.rejects(batch.commit(), { code: "already-exists" });
    assert.equal((await db.doc("orders/new").get()).exists, false);
    assert.equal((await db.doc("orders/existing").get()).get("paymentStatus"), "completed");
    assert.equal(notifications, 0);
    await assert.rejects(db.doc("orders/missing").update({ paymentStatus: "completed" }), { code: "not-found" });
  } finally { db.close(); }
});

test("conflicting async transactions retry without holding the database lock", async () => {
  const db = createLocalStore(":memory:");
  try {
    const ref = db.doc("promoCodes/SAVE");
    await ref.set({ usageCount: 0 });
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const increment = () => db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      reads++;
      if (reads === 2) release();
      if (reads <= 2) await gate;
      transaction.update(ref, { usageCount: snapshot.get("usageCount") + 1 });
    });
    await Promise.all([increment(), increment()]);
    assert.equal((await ref.get()).get("usageCount"), 2);
    assert.equal(reads, 3);
  } finally { db.close(); }
});

test("transactions detect deleted-and-recreated documents and query phantom writes", async () => {
  const db = createLocalStore(":memory:");
  try {
    const ref = db.doc("orders/check");
    let attempts = 0;
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      attempts++;
      if (attempts === 1) {
        await ref.create({ value: 1 });
        await ref.delete();
      }
      assert.equal(snapshot.exists, false);
      transaction.create(ref, { value: 2 });
    });
    assert.equal(attempts, 2);
    attempts = 0;
    await db.runTransaction(async transaction => {
      const query = await transaction.get(db.collection("orders"));
      attempts++;
      if (attempts === 1) await db.doc("orders/phantom").create({ value: 3 });
      transaction.set(db.doc("reports/summary"), { count: query.size });
    });
    assert.equal(attempts, 2);
    assert.equal((await db.doc("reports/summary").get()).get("count"), 2);
  } finally { db.close(); }
});

test("merge, dotted updates, transforms and timestamp queries preserve intended fields", async () => {
  const db = createLocalStore(":memory:");
  try {
    const ref = db.doc("users/one");
    await ref.set({ profile: { name: "A", room: "1" }, count: 2, tags: ["a"], old: true });
    await ref.set({ profile: { room: "2" }, count: { __op: "increment", amount: 3 } }, { merge: true });
    await ref.update({ "profile.name": "B", old: { __op: "deleteField" }, updatedAt: { __op: "serverTimestamp" }, tags: { __op: "arrayUnion", values: ["a", "b"] } });
    const data = (await ref.get()).data()!;
    assert.deepEqual(data.profile, { name: "B", room: "2" });
    assert.equal(data.count, 5);
    assert.equal(data.old, undefined);
    assert.deepEqual(data.tags, ["a", "b"]);
    assert.equal(typeof data.updatedAt.seconds, "number");
    await db.batch().set(db.doc("users/two"), { createdAt: new Date("2026-10-01T00:00:00Z") }).commit();
    assert.equal((await db.doc("users/two").get()).get("createdAt").seconds, 1790812800);
    await db.doc("menu/low").set({ price: 10, active: true });
    await db.doc("menu/high").set({ price: 20, active: true });
    await db.doc("menu/inactive").set({ price: 30, active: false });
    const query = await db.collection("menu").where("active", "==", true).orderBy("price", "desc").limit(1).get();
    assert.deepEqual(query.docs.map(doc => doc.id), ["high"]);
    assert.equal((await db.collection("users").where("createdAt", ">=", { seconds: 1790812800, nanoseconds: 0 }).get()).size, 1);
  } finally { db.close(); }
});

test("export/import is atomic and changes announce committed document paths", async () => {
  const db = createLocalStore(":memory:");
  const restored = createLocalStore(":memory:");
  try {
    const events: string[][] = [];
    const unsubscribe = db.onChange(change => { events.push(change.paths); });
    const ref = await db.collection("menu").add({ name: "Dinner", price: 55 });
    await db.doc("settings/checkout").set({ currency: "ETB" });
    unsubscribe();
    const records = db.exportDocuments();
    assert.equal(await restored.importDocuments(records), 2);
    assert.deepEqual(restored.exportDocuments(), records);
    assert.deepEqual(events, [[ref.path], ["settings/checkout"]]);
    await assert.rejects(restored.importDocuments([{ path: "users/new", data: { name: "New" } }, records[0]]), { code: "already-exists" });
    assert.equal((await restored.doc("users/new").get()).exists, false);
  } finally { db.close(); restored.close(); }
});

test("separate connections share revisions and retry a concurrent payment update", async () => {
  const dir = mkdtempSync(join(tmpdir(), "savory-shared-store-"));
  const path = join(dir, "app.sqlite");
  const first = createLocalStore(path);
  const second = createLocalStore(path);
  try {
    await first.doc("orders/one").create({ paymentStatus: "pending" });
    let attempts = 0;
    await first.runTransaction(async transaction => {
      const snapshot = await transaction.get(first.doc("orders/one"));
      attempts++;
      if (attempts === 1) await second.doc("orders/one").update({ paymentStatus: "completed" });
      if (snapshot.get("paymentStatus") !== "completed") transaction.update(snapshot.ref, { paymentStatus: "pending", checked: true });
    });
    assert.equal(attempts, 2);
    assert.equal((await first.doc("orders/one").get()).get("paymentStatus"), "completed");
    assert.equal(first.currentRevision(), second.currentRevision());
    assert.equal((await first.doc("orders/one").get()).version, first.currentRevision());
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("imported ISO dates and new timestamps share chronological filtering and ordering", async () => {
  const db = createLocalStore(":memory:");
  try {
    const legacyDate = "2026-10-01T10:00:00.000Z";
    await db.doc("orders/legacy").create({ createdAt: legacyDate });
    await db.doc("orders/newer").create({ createdAt: new Date("2026-10-01T12:00:00.000Z") });
    await db.doc("orders/older").create({ createdAt: "2026-10-01T08:00:00+03:00" });
    const lowerBound = new Date("2026-10-01T09:00:00.000Z");
    const filtered = await db.collection("orders").where("createdAt", ">=", lowerBound).orderBy("createdAt", "desc").get();
    assert.deepEqual(filtered.docs.map(doc => doc.id), ["newer", "legacy"]);
    const ordered = await db.collection("orders").orderBy("createdAt", "asc").get();
    assert.deepEqual(ordered.docs.map(doc => doc.id), ["older", "legacy", "newer"]);
    assert.equal((await db.doc("orders/legacy").get()).get("createdAt"), legacyDate);
    assert.equal((await db.collection("orders").where("createdAt", "==", { seconds: Date.parse(legacyDate) / 1000, nanoseconds: 0 }).get()).docs[0].id, "legacy");
  } finally { db.close(); }
});

test("bounded filtered queries stream SQLite rows and stop after enough matching documents", async () => {
  const db = createLocalStore(":memory:");
  try {
    const batch = db.batch();
    for (let index = 0; index < 100; index++) batch.create(db.doc(`menu/${String(index).padStart(3, "0")}`), { active: index % 2 === 1, price: index });
    await batch.commit();
    const sqlite = (db as any).sqlite;
    const prepare = sqlite.prepare.bind(sqlite);
    let visited = 0;
    let bulkReads = 0;
    sqlite.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (!sql.startsWith("SELECT * FROM local_documents")) return statement;
      return {
        all(...args: any[]) { bulkReads++; return statement.all(...args); },
        *iterate(...args: any[]) { for (const row of statement.iterate(...args)) { visited++; yield row; } }
      };
    };
    const result = await db.collection("menu").where("active", "==", true).limit(3).get();
    assert.deepEqual(result.docs.map(document => document.id), ["001", "003", "005"]);
    assert.equal(bulkReads, 0);
    assert.equal(visited, 6);
    // A short read must finalize its iterator before COMMIT and later writes.
    await db.doc("menu/001").update({ price: 500 });
    assert.equal((await db.doc("menu/001").get()).get("price"), 500);
  } finally { db.close(); }
});

test("bounded ordered queries preserve filters, missing-field exclusion, directions, and ID tie breaks", async () => {
  const db = createLocalStore(":memory:");
  try {
    const batch = db.batch();
    const records = Array.from({ length: 150 }, (_, index) => ({
      id: String(index).padStart(3, "0"), active: index % 3 !== 0, group: index % 4,
      ...(index % 11 === 0 ? {} : { price: (index * 23) % 29 })
    }));
    for (const { id, ...data } of records) batch.create(db.doc(`menu/${id}`), data);
    await batch.commit();
    for (const firstDirection of ["asc", "desc"] as const) {
      for (const secondDirection of ["asc", "desc"] as const) {
        const expected = records.filter(record => record.active && record.price !== undefined).sort((a, b) => {
          const group = a.group - b.group;
          const price = a.price! - b.price!;
          return (firstDirection === "asc" ? group : -group) || (secondDirection === "asc" ? price : -price) || a.id.localeCompare(b.id);
        });
        for (const maximum of [1, 2, 17, 149, 5000]) {
          const result = await db.collection("menu").where("active", "==", true).orderBy("group", firstDirection).orderBy("price", secondDirection).limit(maximum).get();
          assert.deepEqual(result.docs.map(document => document.id), expected.slice(0, maximum).map(record => record.id));
          assert.ok(result.size <= maximum);
        }
      }
    }
  } finally { db.close(); }
});
