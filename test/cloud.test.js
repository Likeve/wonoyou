import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { WebSocket } from "ws";
import { createCloudApp } from "../server/cloud-app.js";

const url = process.env.TEST_REDIS_URL;
test("cloud: shared authentication, identity-code contacts, cross-instance signaling and restart", { skip: !url, timeout: 180000 }, async () => {
  const namespace = "inou-test-" + randomUUID();
  const services = [], clients = [];
  async function start() {
    const service = createCloudApp({ url, namespace });
    services.push(service);
    await service.store.ready();
    await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
    service.base = `http://127.0.0.1:${service.server.address().port}`;
    return service;
  }
  async function request(service, path, { method = "GET", body, token } = {}) {
    const response = await fetch(service.base + "/api/" + path, { method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, ...await response.json() };
  }
  async function identity(a, b, name) {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = Buffer.from(await webcrypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
    const challenge = await request(a, "challenge", { method: "POST", body: { publicKey } });
    assert.equal(challenge.status, 200);
    const signature = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, Buffer.from("INOU-AUTH:" + challenge.nonce))).toString("base64");
    const session = await request(b, "session", { method: "POST", body: { nonce: challenge.nonce, signature, name } });
    assert.equal(session.status, 200);
    assert.equal((await request(a, "session", { method: "POST", body: { nonce: challenge.nonce, signature } })).status, 401);
    return session;
  }
  function waitMessage(ws, predicate, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.off("message", listen); reject(new Error("Timed out waiting for WebSocket event")); }, timeout);
      function listen(raw) { const message = JSON.parse(raw); if (predicate(message)) { clearTimeout(timer); ws.off("message", listen); resolve(message); } }
      ws.on("message", listen);
    });
  }
  async function connect(service, token) {
    const ws = new WebSocket(service.base.replace("http:", "ws:") + "/signal", { origin: service.base });
    clients.push(ws);
    const contacts = waitMessage(ws, m => m.type === "contacts");
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    await contacts;
    return ws;
  }
  try {
    const a = await start(), b = await start();
    assert.equal((await request(a, "contacts")).status, 401);
    const alice = await identity(a, b, "小林"), bob = await identity(b, a, "阿青"), eve = await identity(a, b, "路人");
    const friend = bob, stranger = eve;
    assert.equal((await request(b, "contacts", { method: "POST", token: friend.token, body: { id: alice.id } })).status, 200);
    assert.equal((await request(b, "contacts", { method: "POST", token: friend.token, body: { id: alice.id } })).status, 200);
    const contacts = await request(b, "contacts", { token: alice.token });
    assert.deepEqual(contacts.contacts.map(c => c.id), [friend.id]);
    assert.equal((await request(b, "identity/" + alice.id, { token: friend.token })).name, "小林");
    const wsA = await connect(a, alice.token), wsB = await connect(b, friend.token);
    assert.equal((await request(b, "contacts", { token: alice.token })).contacts[0].online, true);
    assert.equal((await request(a, "contacts", { token: friend.token })).contacts[0].online, true);
    const groupEvent = waitMessage(wsB, m => m.type === "groups-changed");
    const createdGroup = await request(a, "groups", { method: "POST", token: alice.token, body: { name: "跨实例群", members: [friend.id] } });
    assert.equal(createdGroup.status, 200);
    await groupEvent;
    assert.equal((await request(b, "groups", { token: friend.token })).groups[0].id, createdGroup.group.id);
    const membershipEvent = waitMessage(wsA, m => m.type === "groups-changed");
    assert.equal((await request(b, `groups/${createdGroup.group.id}/members`, { method: "POST", token: friend.token, body: { members: [stranger.id] } })).status, 200);
    await membershipEvent;
    assert.equal((await request(a, "groups", { token: stranger.token })).groups[0].members.length, 3);
    const received = waitMessage(wsB, m => m.type === "signal");
    const marker = "transient-signal-" + randomUUID();
    wsA.send(JSON.stringify({ type: "signal", to: friend.id, payload: marker, signature: "test" }));
    assert.equal((await received).payload, marker);
    let forbidden = 0;
    wsB.on("message", raw => { if (JSON.parse(raw).type === "signal") forbidden++; });
    const wsE = await connect(a, stranger.token);
    wsE.send(JSON.stringify({ type: "signal", to: friend.id, payload: "forbidden", signature: "test" }));
    wsA.send(JSON.stringify({ type: "message", to: friend.id, payload: "must-not-store" }));
    assert.equal((await request(b, "messages", { method: "POST", token: alice.token, body: { message: "must-not-store" } })).status, 404);
    assert.equal((await request(b, "contacts", { method: "POST", token: alice.token, body: { id: "f".repeat(64) } })).status, 400);
    assert.equal((await request(b, "contacts", { method: "POST", token: alice.token, body: { id: alice.id } })).status, 400);
    // Force a function instance restart. Shared sessions and contacts must survive.
    await a.close(); services.splice(services.indexOf(a), 1);
    const restarted = await start();
    assert.equal((await request(restarted, "contacts", { token: alice.token })).contacts[0].id, friend.id);
    const wsRestarted = await connect(restarted, alice.token);
    const afterRestart = waitMessage(wsRestarted, m => m.type === "signal");
    wsB.send(JSON.stringify({ type: "signal", to: alice.id, payload: "after-restart", signature: "test" }));
    assert.equal((await afterRestart).payload, "after-restart");
    await request(restarted, "contacts/" + friend.id + "?block=true", { method: "DELETE", token: alice.token });
    wsRestarted.send(JSON.stringify({ type: "signal", to: friend.id, payload: "blocked", signature: "test" }));
    assert.equal((await request(b, "contacts", { method: "POST", token: friend.token, body: { id: alice.id } })).status, 400);
    assert.equal((await request(b, "contacts", { token: friend.token })).contacts.length, 0);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(forbidden, 0);
    // Inspect only our random test namespace; no signal or chat payload may persist.
    let cursor = "0";
    do {
      const [next, keys] = await b.store.redis.scan(cursor, "MATCH", b.store.key("*"), "COUNT", 100);
      cursor = next;
      for (const key of keys) {
        assert.equal(/:message|:attachment|:signal/.test(key), false);
        const type = await b.store.redis.type(key);
        assert.ok(["string", "hash", "set"].includes(type));
        const value = type === "string" ? await b.store.redis.get(key) : type === "hash" ? await b.store.redis.hgetall(key) : await b.store.redis.smembers(key);
        assert.equal(JSON.stringify(value).includes(marker), false);
        assert.equal(JSON.stringify(value).includes("must-not-store"), false);
      }
    } while (cursor !== "0");
  } finally {
    for (const ws of clients) ws.terminate();
    // Delete only keys this test created; never FLUSHDB.
    const store = services.find(s => s.store.redis.status === "ready")?.store;
    if (store) {
      let cursor = "0", cleanup = [];
      do { const [next, keys] = await store.redis.scan(cursor, "MATCH", store.key("*"), "COUNT", 100); cursor = next; cleanup.push(...keys); } while (cursor !== "0");
      if (cleanup.length) await store.redis.del(...cleanup);
    }
    for (const service of services) await service.close();
  }
});
