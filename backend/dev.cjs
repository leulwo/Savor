// Local development always mounts Vite, even when the root .env is configured
// with NODE_ENV=production for Coolify.
process.env.NODE_ENV = "development";
require("tsx/cjs");
require("./server.ts");
