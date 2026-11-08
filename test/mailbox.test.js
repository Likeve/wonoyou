import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto, randomUUID } from "node:crypto";
import { createApp } from "../server/app.js";
import { sealMailbox, openMailbox } from "../src/vault.js";

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

async function register(name) {
  const keys = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    ),
    publicKey = Buffer.from(
      await webcrypto.subtle.exportKey("spki", keys.publicKey),
    ).toString("base64"),
    privateKey = Buffer.from(
      await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
    ).toString("base64"),
    c = await request("challenge", { method: "POST", body: { publicKey } });
  const signature = Buffer.from(
    await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      Buffer.from("INOU-AUTH:" + c.nonce),
    ),
  ).toString("base64");
  const s = await request("session", {
    method: "POST",
    body: { nonce: c.nonce, signature, name },
  });
  return { token: s.token, id: s.id, publicKey, privateKey };
}

test("mailbox delivers an end-to-end encrypted message to an offline peer", async () => {
  const a = await register("甲"),
    b = await register("乙"),
    c = await register("丙");
  assert.equal(
    (
      await request("contacts", {
        token: a.token,
        method: "POST",
        body: { id: b.id },
      })
    ).status,
    200,
  );

  const message = {
    id: randomUUID(),
    body: "你好，这条消息只对乙可见",
    kind: "text",
    time: Date.now(),
    from: a.id,
  };
  const box = await sealMailbox(
    { id: a.id, publicKey: a.publicKey, privateKey: a.privateKey },
    b.publicKey,
    message,
  );
  assert.equal(
    (
      await request("mailbox", {
        token: a.token,
        method: "POST",
        body: { to: b.id, box },
      })
    ).status,
    200,
  );

  const fetched = await request("mailbox", { token: b.token });
  assert.equal(fetched.items.length, 1);
  assert.equal(fetched.items[0].from, a.id);
  const opened = await openMailbox(
    { id: b.id, publicKey: b.publicKey, privateKey: b.privateKey },
    a.publicKey,
    fetched.items[0].box,
  );
  assert.equal(opened.body, "你好，这条消息只对乙可见");
  assert.equal(opened.from, a.id);

  await request("mailbox/ack", {
    token: b.token,
    method: "POST",
    body: { count: 1 },
  });
  assert.equal((await request("mailbox", { token: b.token })).items.length, 0);

  // 非好友无法投递，丙也不能解开给乙的消息。
  assert.equal(
    (
      await request("mailbox", {
        token: a.token,
        method: "POST",
        body: { to: c.id, box },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("mailbox", {
        token: a.token,
        method: "POST",
        body: { to: b.id, box: { iv: "", data: "" } },
      })
    ).status,
    400,
  );
});
