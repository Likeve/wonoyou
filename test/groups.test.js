import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto, randomUUID } from "node:crypto";
import { createCloudApp } from "../server/cloud-app.js";
import { createApp } from "../server/app.js";
import { sealMailbox, openMailbox, exportArchive, readArchive } from "../src/vault.js";

const cloud = process.env.INOU_TEST_GROUP_BACKEND === "redis";
let service, base;
before(async () => {
  service = cloud ? createCloudApp({ url: process.env.TEST_REDIS_URL, namespace: "inou-group-test-" + randomUUID() }) : createApp({ dbPath: ":memory:" });
  if (cloud) await service.store.ready();
  await new Promise((r) => service.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${service.server.address().port}`;
});
after(async () => {
  if (cloud) {
    const keys = await service.store.redis.keys(service.store.key("*"));
    if (keys.length) await service.store.redis.del(...keys);
  }
  await service.close();
});

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

test("groups require other identities, synchronize membership and protect encrypted mail", async () => {
  const a = await register("群主"), b = await register("成员"), c = await register("新成员"), outsider = await register("路人");
  const create = body => request("groups", { token: a.token, method: "POST", body });
  assert.equal((await request("groups")).status, 401);
  for (const members of [[], [a.id], ["bad"], ["f".repeat(64)], [b.id, "f".repeat(64)]]) {
    assert.equal((await create({ name: "测试群", members })).status, 400);
  }
  assert.deepEqual((await request("groups", { token: b.token })).groups, []);
  const created = await create({ name: "测试群", members: ["INOU-" + b.id.toUpperCase().match(/.{4}/g).join("-"), b.id] });
  assert.equal(created.status, 200);
  const group = created.group;
  assert.equal(group.members.length, 2);
  assert.equal((await request("groups", { token: b.token })).groups[0].id, group.id);
  assert.deepEqual((await request("groups", { token: outsider.token })).groups, []);
  assert.equal((await request(`groups/${group.id}/members`, { token: outsider.token, method: "POST", body: { members: [c.id] } })).status, 403);
  assert.equal((await request(`groups/${group.id}/members`, { token: b.token, method: "POST", body: { members: [c.id] } })).status, 200);
  assert.equal((await request("groups", { token: c.token })).groups[0].members.length, 3);
  assert.deepEqual((await request("contacts", { token: c.token })).contacts, []);
  const message = { id: randomUUID(), from: a.id, to: b.id, groupId: group.id, body: "只在设备解密", kind: "text", time: Date.now() };
  const box = await sealMailbox(a, b.publicKey, message);
  const send = (user, to) => request("mailbox", { token: user.token, method: "POST", body: { to, groupId: group.id, box } });
  assert.equal((await send(outsider, b.id)).status, 403);
  assert.equal((await send(a, outsider.id)).status, 403);
  assert.equal((await send(a, b.id)).status, 200);
  const items = (await request("mailbox", { token: b.token })).items;
  assert.equal(items[0].groupId, group.id);
  assert.deepEqual(await openMailbox(b, a.publicKey, items[0].box), message);
  assert.ok(!JSON.stringify(items).includes(message.body));
  await request("mailbox/ack", { token: outsider.token, method: "POST", body: { ids: [items[0].id] } });
  assert.equal((await request("mailbox", { token: b.token })).items.length, 1);
  await request("mailbox/ack", { token: b.token, method: "POST", body: { ids: [items[0].id] } });
  assert.equal((await request("mailbox", { token: b.token })).items.length, 0);
  await request(`contacts/${a.id}?block=true`, { token: outsider.token, method: "DELETE" });
  assert.equal((await request(`groups/${group.id}/members`, { token: a.token, method: "POST", body: { members: [outsider.id] } })).status, 403);
});

test("group history survives encrypted backup without restoring send jobs", async () => {
  const owner = "a".repeat(64), member = "b".repeat(64), id = "group-" + randomUUID();
  const state = { identity: { id: owner, name: "群主" }, contacts: [], groups: [{ id, name: "备份群", owner, members: [{ id: owner, name: "群主" }, { id: member, name: "成员" }] }],
    messages: [{ id: randomUUID(), peer: id, groupId: id, sender: owner, body: "群聊历史", kind: "text", time: Date.now(), status: "pending" }] };
  const file = await exportArchive(state, "isolated-test-password");
  const restored = await readArchive(file, "isolated-test-password");
  assert.equal(restored.groups[0].id, id);
  assert.equal(restored.messages[0].status, "archived");
  assert.equal(restored.messages[0].body, "群聊历史");
  await assert.rejects(readArchive(file, "wrong-password"));
});
