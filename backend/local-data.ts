import fs from "node:fs";
import path from "node:path";
import type { LocalStore } from "./local-store";

/** Imports the existing local export once. Existing documents are never replaced. */
export async function initializeLocalData(db: LocalStore, appRoot: string) {
  await db.runTransaction(async transaction => {
    const marker = db.doc("_local/migration-v1");
    if ((await transaction.get(marker)).exists) return;
    const legacyPath = path.join(appRoot, "data", "db.json");
    const legacy = fs.existsSync(legacyPath) ? JSON.parse(fs.readFileSync(legacyPath, "utf8")) : {};
    const pending: { ref: any; data: any }[] = [];
    for (const collection of ["menu", "orders", "categories", "settings", "promoCodes", "users", "admins", "roles", "reservations", "reviews", "chat_messages"]) {
      const entries = legacy[collection];
      if (!entries) continue;
      const records = Array.isArray(entries) ? entries.map((data: any) => [String(data.id || ""), data]) : Object.entries(entries);
      for (const [id, data] of records) {
        if (!id || typeof data !== "object" || !data || id.includes("/")) throw new Error(`Invalid ${collection} record in local export.`);
        const ref = db.collection(collection).doc(id);
        if (!(await transaction.get(ref)).exists) pending.push({ ref, data });
      }
    }
    // Fresh local installations need the settings documents expected by both
    // the restaurant and checkout. Import values take precedence over defaults.
    const global = db.doc("settings/global");
    if (!(await transaction.get(global)).exists && !pending.some(record => record.ref.path === global.path)) {
      pending.push({ ref: global, data: {
        restaurantName: "", logoUrl: "", businessEmail: "", businessPhone: "", businessAddress: "",
        serviceTaxPercent: 15, flatFeeETB: 0, enableCOD: true, isOpen: true,
        scheduleEnabled: false, openTime: "09:00", closeTime: "22:00", enableMarketing: true,
        enableReservations: true, enableChatbot: true, prepTimeMinutes: 30, scheduledStepsMinutes: 15
      } });
    }
    const checkout = db.doc("settings/checkout");
    if (!(await transaction.get(checkout)).exists && !pending.some(record => record.ref.path === checkout.path)) {
      const globalData = pending.find(record => record.ref.path === global.path)?.data || (await transaction.get(global)).data();
      pending.push({ ref: checkout, data: { ...globalData } });
    }
    const categoryNames = new Set<string>();
    for (const record of pending.filter(record => record.ref.path.startsWith("menu/"))) {
      for (const name of [record.data.category, ...(Array.isArray(record.data.categories) ? record.data.categories : [])]) {
        if (typeof name === "string" && name.trim()) categoryNames.add(name.trim());
      }
    }
    for (const name of categoryNames) {
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || Buffer.from(name).toString("hex");
      const ref = db.collection("categories").doc(id);
      if (!(await transaction.get(ref)).exists && !pending.some(record => record.ref.path === ref.path)) pending.push({ ref, data: { name } });
    }
    for (const record of pending) transaction.create(record.ref, record.data);
    transaction.create(marker, { importedAt: new Date().toISOString(), importedDocuments: pending.length, schemaVersion: 1 });
  });
}
