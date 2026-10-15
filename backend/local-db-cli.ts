import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { createLocalStore } from "./local-store";
import { adminPermissionKeys as permissionKeys } from "./primary-admin";

type DocumentRecord = { path: string; data: Record<string, any> };

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRecords(records: unknown): DocumentRecord[] {
  if (!Array.isArray(records)) throw new Error("Import must contain an array of document records.");
  const paths = new Set<string>();
  return records.map((record, index) => {
    if (!isObject(record) || typeof record.path !== "string" || !isObject(record.data)) {
      throw new Error(`Import document ${index + 1} must contain a path and an object data field.`);
    }
    const segments = record.path.split("/");
    if (segments.length < 2 || segments.length % 2 !== 0 || segments.some(segment => !segment || segment === "." || segment === ".." || /[\\\u0000-\u001f]/.test(segment))) {
      throw new Error(`Import document ${index + 1} has an invalid document path.`);
    }
    if (paths.has(record.path)) throw new Error("Import contains duplicate document paths.");
    paths.add(record.path);
    return { path: record.path, data: record.data };
  });
}

function importRecords(value: unknown): DocumentRecord[] {
  if (Array.isArray(value)) return validateRecords(value);
  if (!isObject(value)) throw new Error("Import must be a document array or a collection export object.");
  if ("records" in value) return validateRecords(value.records);
  if ("documents" in value) return validateRecords(value.documents);
  const collections = "collections" in value ? value.collections : value;
  if (!isObject(collections)) throw new Error("Import collections must be an object.");
  const records: DocumentRecord[] = [];
  for (const [collection, documents] of Object.entries(collections)) {
    if (!Array.isArray(documents)) throw new Error("Every imported collection must be an array of documents.");
    for (const document of documents) {
      if (!isObject(document) || typeof document.id !== "string" || !document.id) {
        throw new Error("Every legacy collection document must have a nonempty string id.");
      }
      if (document.id.includes("/")) throw new Error("Legacy document ids cannot contain slashes.");
      records.push({ path: `${collection}/${document.id}`, data: { ...document } });
    }
  }
  return validateRecords(records);
}

function projectRoot(): string {
  if (process.env.APP_ROOT) return path.resolve(process.env.APP_ROOT);
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, "frontend")) ? cwd : path.resolve(cwd, "..");
}

async function main(): Promise<void> {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (!["status", "owner", "export", "import"].includes(command || "") || extra.length || (command === "status" ? argument !== undefined : !argument)) {
    throw new Error("Usage: db:status | db:owner -- email | db:export -- file.json | db:import -- file.json");
  }
  const appRoot = projectRoot();
  dotenv.config({ path: path.join(appRoot, ".env"), quiet: true });
  const configuredPath = String(process.env.DATABASE_PATH || "data/savory.sqlite").trim();
  const databasePath = path.resolve(appRoot, configuredPath);
  const store = createLocalStore(databasePath);
  try {
    if (command === "status") {
      const counts: Record<string, number> = {};
      for (const collection of store.listCollections()) {
        const safeName = collection.split("/").map((segment, index) => index % 2 ? "*" : segment).join("/");
        const snapshot = await store.collection(collection).get();
        counts[safeName] = (counts[safeName] || 0) + snapshot.size;
      }
      console.log(JSON.stringify({ documents: Object.values(counts).reduce((total, count) => total + count, 0), collections: counts }, null, 2));
      return;
    }
    if (command === "owner") {
      const email = argument!.trim().toLowerCase();
      if (email.length > 254 || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(email) || /[\u0000-\u001f]/.test(email)) {
        throw new Error("Owner email must be a valid email address.");
      }
      const adminRef = store.collection("admins").doc(email);
      const roleRef = store.collection("roles").doc("admin");
      let created = false;
      await store.runTransaction(async transaction => {
        const [admin, role] = await Promise.all([transaction.get(adminRef), transaction.get(roleRef)]);
        if (admin.exists) {
          const record = admin.data() || {};
          if (record.role !== "admin" || record.active === false || record.disabled === true || ["disabled", "inactive"].includes(String(record.status || "").toLowerCase())) {
            throw new Error("This account already has a different or inactive staff record. No changes were made.");
          }
        }
        if (!role.exists) transaction.create(roleRef, {
          id: "admin", name: "Admin", description: "Full access to every module and setting.",
          builtin: true, permissions: Object.fromEntries(permissionKeys.map(key => [key, true]))
        });
        if (!admin.exists) {
          transaction.create(adminRef, { email, role: "admin", active: true, createdAt: new Date().toISOString() });
          created = true;
        }
      });
      console.log(created ? "Owner account created. Sign in with that Google account." : "The active owner account already exists. No changes were made.");
      return;
    }
    const filePath = path.resolve(appRoot, argument!);
    if (filePath === databasePath || ["-wal", "-shm", "-journal"].some(suffix => filePath === databasePath + suffix)) {
      throw new Error("The JSON file must be different from the database files.");
    }
    if (command === "export") {
      const records = store.exportDocuments();
      const body = JSON.stringify({ format: "savory-local-db", version: 1, exportedAt: new Date().toISOString(), records }, null, 2);
      fs.writeFileSync(filePath, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
      console.log(`Exported ${records.length} documents to the requested file.`);
      return;
    }
    const records = importRecords(JSON.parse(fs.readFileSync(filePath, "utf8")));
    const count = await store.importDocuments(records);
    console.log(`Imported ${count} documents. Existing documents were not overwritten.`);
  } finally {
    store.close();
  }
}

void main().catch((error: any) => {
  if (error?.code === "already-exists") console.error("Import conflicts with an existing document. The import was rolled back; existing data is unchanged.");
  else if (error?.code === "EEXIST") console.error("The export file already exists. Choose a new filename; it was not overwritten.");
  else if (error?.code === "ENOENT") console.error("The requested file or parent folder does not exist.");
  else if (error instanceof SyntaxError) console.error("The import file is not valid JSON.");
  else console.error(error?.message || "Database command failed.");
  process.exitCode = 1;
});
