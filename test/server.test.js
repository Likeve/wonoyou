import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createApp } from "../server/app.js";
import { WebSocket } from "ws";
let service, base;
before(async () => {
  service = createApp({ dbPath: ":memory:" });
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${service.server.address().port}`;
});
after(() => service.close());
async function request(path, { token, method = "GET", body } = {}) {
  const r = await fetch(base + "/api/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ...(await r.json()) };
}
async function identity() {
  const keys = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ),
    publicKey = Buffer.from(
      await webcrypto.subtle.exportKey("spki", keys.publicKey),
    ).toString("base64"),
    c = await request("challenge", { method: "POST", body: { publicKey } });
  const signature = Buffer.from(
    await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      Buffer.from("INOU-AUTH:" + c.nonce),
    ),
  ).toString("base64");
  return request("session", {
    method: "POST",
    body: { nonce: c.nonce, signature },
  });
}
test("authentication required and unknown content APIs are absent", async () => {
  assert.equal((await request("contacts")).status, 401);
  const a = await identity();
  assert.equal(
    (
      await request("messages", {
        token: a.token,
        method: "POST",
        body: { body: "must-not-store" },
      })
    ).status,
    404,
  );
  assert.equal(
    service.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .some((r) => /message|attachment/i.test(r.name)),
    false,
  );
});
test("invalid proof and replayed challenge are rejected", async () => {
  const keys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = Buffer.from(
    await webcrypto.subtle.exportKey("spki", keys.publicKey),
  ).toString("base64");
  const c = await request("challenge", { method: "POST", body: { publicKey } });
  assert.equal(
    (
      await request("session", {
        method: "POST",
        body: { nonce: c.nonce, signature: "AAAA" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("session", {
        method: "POST",
        body: { nonce: c.nonce, signature: "AAAA" },
      })
    ).status,
    401,
  );
});
test("one-sided invite adds both sides, is idempotent, and cannot be stolen", async () => {
  const a = await identity(),
    b = await identity(),
    c = await identity(),
    inv = await request("invites", { method: "POST", token: b.token });
  assert.match(inv.code, /^INOU-/);
  const add = () =>
    request("contacts", {
      method: "POST",
      token: a.token,
      body: { code: inv.code },
    });
  assert.equal((await add()).id, b.id);
  assert.equal((await add()).status, 200);
  assert.equal(
    (await request("contacts", { token: b.token })).contacts[0].id,
    a.id,
  );
  assert.equal(
    (
      await request("contacts", {
        method: "POST",
        token: c.token,
        body: { code: inv.code },
      })
    ).status,
    400,
  );
  const stored = service.db
    .prepare("SELECT * FROM invites WHERE owner=?")
    .get(b.id);
  assert.equal(stored.hash.includes(inv.code), false);
});
test("concurrent redemption has exactly one winner", async () => {
  const a = await identity(),
    b = await identity(),
    c = await identity(),
    inv = await request("invites", { method: "POST", token: b.token });
  const results = await Promise.all(
    [a, c].map((x) =>
      request("contacts", {
        method: "POST",
        token: x.token,
        body: { code: inv.code },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
});
test("revocation, expiry, self-add and block cannot establish a relation", async () => {
  const a = await identity(),
    b = await identity();
  let inv = await request("invites", { method: "POST", token: b.token });
  assert.equal(
    (
      await request("contacts", {
        method: "POST",
        token: b.token,
        body: { code: inv.code },
      })
    ).status,
    400,
  );
  await request("invites", { method: "DELETE", token: b.token });
  assert.equal(
    (
      await request("contacts", {
        method: "POST",
        token: a.token,
        body: { code: inv.code },
      })
    ).status,
    400,
  );
  inv = await request("invites", { method: "POST", token: b.token });
  service.db.prepare("UPDATE invites SET expires=0 WHERE owner=?").run(b.id);
  assert.equal(
    (
      await request("contacts", {
        method: "POST",
        token: a.token,
        body: { code: inv.code },
      })
    ).status,
    400,
  );
  inv = await request("invites", { method: "POST", token: b.token });
  await request("contacts", {
    method: "POST",
    token: a.token,
    body: { code: inv.code },
  });
  await request("contacts/" + b.id + "?block=true", {
    method: "DELETE",
    token: a.token,
  });
  assert.equal(
    (await request("contacts", { token: b.token })).contacts.length,
    0,
  );
  inv = await request("invites", { method: "POST", token: b.token });
  assert.equal(
    (
      await request("contacts", {
        method: "POST",
        token: a.token,
        body: { code: inv.code },
      })
    ).status,
    400,
  );
});
test("signaling requires membership and ignores chat messages", async () => {
  const a = await identity(),
    b = await identity(),
    wsA = new WebSocket(base.replace("http", "ws") + "/signal"),
    wsB = new WebSocket(base.replace("http", "ws") + "/signal");
  await Promise.all(
    [wsA, wsB].map((ws) => new Promise((r) => ws.on("open", r))),
  );
  const received = [];
  wsB.on("message", (m) => received.push(JSON.parse(m)));
  wsA.send(JSON.stringify({ type: "auth", token: a.token }));
  wsB.send(JSON.stringify({ type: "auth", token: b.token }));
  await new Promise((r) => setTimeout(r, 50));
  wsA.send(
    JSON.stringify({
      type: "signal",
      to: b.id,
      payload: "unauthorized",
      signature: "x",
    }),
  );
  wsA.send(JSON.stringify({ type: "message", to: b.id, body: "never relay" }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(
    received.some((x) => x.type === "signal" || x.type === "message"),
    false,
  );
  wsA.close();
  wsB.close();
});
