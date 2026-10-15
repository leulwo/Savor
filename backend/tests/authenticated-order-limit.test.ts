import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { authenticatedOrderLimit, safeApiError } from "../http-security";

const uidA = "fixture-customer-a-not-a-token";
const uidB = "fixture-customer-b-not-a-token";
const tokenA = "synthetic-private-firebase-token-a";
const refreshedTokenA = "synthetic-private-firebase-token-a-refreshed";
const tokenB = "synthetic-private-firebase-token-b";
const principals = new Map([[tokenA, uidA], [refreshedTokenA, uidA], [tokenB, uidB]]);

async function harness() {
  const app = express();
  // This fixture is its own trusted loopback proxy, so requests can exercise
  // genuinely different req.ip values without using any public interface.
  app.set("trust proxy", "loopback");
  app.use(express.json());
  app.use((req, res, next) => {
    const token = /^Bearer (\S+)$/.exec(req.get("authorization") || "")?.[1];
    const uid = principals.get(token || "");
    if (!uid) return res.status(401).json({ code: "AUTH_SESSION_EXPIRED" });
    // Like production, only verified authentication populates this value.
    res.locals.uid = uid;
    next();
  });
  const limiter = authenticatedOrderLimit();
  const accepted: { path: string; ip: string }[] = [];
  for (const resource of ["/api/orders", "/api/chapa/initialize"]) {
    app.post(resource, limiter, (req, res) => {
      accepted.push({ path: req.path, ip: req.ip || "" });
      res.status(201).json({ success: true });
    });
  }
  app.use(safeApiError);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    accepted,
    request(index: number, options: { token?: string; ip?: string; body?: Record<string, any> } = {}) {
      const resource = index % 2 ? "/api/chapa/initialize" : "/api/orders";
      return fetch(base + resource, {
        method: "POST", headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.token ?? tokenA}`,
          "x-forwarded-for": options.ip ?? "192.0.2.1",
          "x-user-id": `untrusted-user-${index}`,
        },
        body: JSON.stringify(options.body || { userId: `untrusted-user-${index}` }),
        signal: AbortSignal.timeout(5000),
      });
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function checkedResponse(response: Response) {
  const text = await response.text();
  const visible = JSON.stringify([...response.headers.entries()]) + text;
  for (const privateValue of [tokenA, refreshedTokenA, tokenB, uidA, uidB]) {
    assert.equal(visible.includes(privateValue), false, "Rate-limit responses must not disclose tokens or the raw account key");
  }
  return JSON.parse(text);
}

test("authenticated checkout quota follows the UID across IPs, token refresh and both order endpoints", async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 30; index++) {
      const response = await h.request(index, { token: index % 2 ? refreshedTokenA : tokenA, ip: `192.0.2.${index + 1}` });
      assert.equal(response.status, 201);
      assert.deepEqual(await checkedResponse(response), { success: true });
    }
    assert.equal(h.accepted.length, 30);
    assert.equal(new Set(h.accepted.map(request => request.ip)).size, 30);
    assert.equal(new Set(h.accepted.map(request => request.path)).size, 2);
    for (const [index, token] of [[30, tokenA], [31, refreshedTokenA]] as const) {
      const response = await h.request(index, { token, ip: "198.51.100.123", body: { userId: uidB } });
      assert.equal(response.status, 429);
      assert.deepEqual(await checkedResponse(response), {
        success: false, code: "CHECKOUT_RATE_LIMITED",
        error: "Too many checkout requests. Please wait before trying again.", retryAction: "wait",
      });
      const retryAfter = Number(response.headers.get("retry-after"));
      assert.ok(retryAfter > 0 && retryAfter <= 600);
      assert.match(response.headers.get("ratelimit-policy") || "", /q=30; w=600/);
      assert.equal(response.headers.get("x-ratelimit-limit"), null);
    }
    assert.equal(h.accepted.length, 30);
  } finally { await h.close(); }
});

test("separate authenticated users retain separate quotas on the same IP", async () => {
  const h = await harness();
  try {
    for (const token of [tokenA, tokenB]) {
      for (let index = 0; index < 30; index++) {
        const response = await h.request(index, { token, ip: "192.0.2.20" });
        assert.equal(response.status, 201);
        await checkedResponse(response);
      }
      const limited = await h.request(30, { token, ip: "192.0.2.20" });
      assert.equal(limited.status, 429);
      await checkedResponse(limited);
    }
    assert.equal(h.accepted.length, 60);
    assert.deepEqual([...new Set(h.accepted.map(request => request.ip))], ["192.0.2.20"]);
  } finally { await h.close(); }
});

test("parallel authenticated requests cannot exceed the 30-request allowance", async () => {
  const h = await harness();
  try {
    const statuses = await Promise.all(Array.from({ length: 50 }, async (_value, index) => {
      const response = await h.request(index, { token: index % 2 ? refreshedTokenA : tokenA, ip: `198.51.100.${index + 1}` });
      await checkedResponse(response);
      return response.status;
    }));
    assert.equal(statuses.filter(status => status === 201).length, 30);
    assert.equal(statuses.filter(status => status === 429).length, 20);
    assert.equal(h.accepted.length, 30);
  } finally { await h.close(); }
});

test("rejected authentication never consumes an authenticated account's quota", async () => {
  const h = await harness();
  try {
    for (let index = 0; index < 35; index++) {
      const response = await h.request(index, { token: "invalid-synthetic-token", body: { uid: uidA, userId: uidA } });
      assert.equal(response.status, 401);
      await checkedResponse(response);
    }
    assert.equal(h.accepted.length, 0);
    for (let index = 0; index < 30; index++) {
      const response = await h.request(index);
      assert.equal(response.status, 201);
      await checkedResponse(response);
    }
    const limited = await h.request(30);
    assert.equal(limited.status, 429);
    await checkedResponse(limited);
    assert.equal(h.accepted.length, 30);
  } finally { await h.close(); }
});
