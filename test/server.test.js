import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
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
async function identity(name) {
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
    body: { nonce: c.nonce, signature, name },
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
test("browser security policy permits the configured Supabase account service", async () => {
  const supabaseOrigin = "https://eqxqouawuwoqecdofoxx.supabase.co";
  const health = await fetch(base + "/api/health");
  assert.match(health.headers.get("content-security-policy") || "", new RegExp(supabaseOrigin.replaceAll(".", "\\.")));
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const policy = config.headers
    .flatMap((entry) => entry.headers || [])
    .find((header) => header.key === "Content-Security-Policy")?.value || "";
  assert.ok(policy.includes("connect-src 'self' " + supabaseOrigin + " wss:"));
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
test("identity code adds both sides, is idempotent, and is reusable", async () => {
  const a = await identity("小林"),
    b = await identity("阿青"),
    c = await identity("路人");
  const add = (from, peer) =>
    request("contacts", {
      method: "POST",
      token: from.token,
      body: { id: peer.id },
    });
  assert.equal((await add(a, b)).id, b.id);
  assert.equal((await add(a, b)).status, 200);
  assert.equal(
    (await request("contacts", { token: b.token })).contacts[0].id,
    a.id,
  );
  assert.equal(
    (await request("contacts", { token: b.token })).contacts[0].name,
    "小林",
  );
  // The identity code is public and long-lived: anyone else may add the same person.
  assert.equal((await add(c, b)).status, 200);
});
test("identity lookup previews the peer name and rejects unknown codes", async () => {
  const a = await identity("小林"),
    b = await identity("阿青");
  assert.equal((await request("identity/" + b.id, { token: a.token })).name, "阿青");
  assert.equal(
    (await request("identity/" + "f".repeat(64), { token: a.token })).status,
    400,
  );
  assert.equal(
    (await request("identity/" + "not-a-code", { token: a.token })).status,
    400,
  );
});
test("re-registering a device updates its display name", async () => {
  const keys = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = Buffer.from(
    await webcrypto.subtle.exportKey("spki", keys.publicKey),
  ).toString("base64");
  const register = async (name) => {
    const c = await request("challenge", {
      method: "POST",
      body: { publicKey },
    });
    const signature = Buffer.from(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        Buffer.from("INOU-AUTH:" + c.nonce),
      ),
    ).toString("base64");
    return request("session", {
      method: "POST",
      body: { nonce: c.nonce, signature, name },
    });
  };
  const first = await register();
  assert.equal(
    (await request("identity/" + first.id, { token: first.token })).name,
    "",
  );
  const second = await register("No.2");
  assert.equal(
    (await request("identity/" + second.id, { token: second.token })).name,
    "No.2",
  );
});
test("self-add, malformed and unknown identity codes are rejected", async () => {
  const a = await identity();
  assert.equal(
    (
      await request("contacts", {
        method: "POST",
        token: a.token,
        body: { id: a.id },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("contacts", {
        method: "POST",
        token: a.token,
        body: { id: "not-a-code" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("contacts", {
        method: "POST",
        token: a.token,
        body: { id: "f".repeat(64) },
      })
    ).status,
    400,
  );
});
test("block prevents adding and re-adding after unblock", async () => {
  const a = await identity(),
    b = await identity();
  const add = () =>
    request("contacts", { method: "POST", token: a.token, body: { id: b.id } });
  assert.equal((await add()).status, 200);
  await request("contacts/" + b.id + "?block=true", {
    method: "DELETE",
    token: a.token,
  });
  assert.equal(
    (await request("contacts", { token: b.token })).contacts.length,
    0,
  );
  assert.equal((await add()).status, 400);
  await request("blocks/" + b.id, { method: "DELETE", token: a.token });
  assert.equal((await add()).status, 200);
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
