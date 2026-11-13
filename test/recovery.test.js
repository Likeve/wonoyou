import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHash } from "node:crypto";
import { createRecoveryHandler } from "../server/recovery.js";
import { generateRecoveryPhrase, recoveryHash } from "../src/recovery.js";

const phrase = "山 海 星 月 春 风 秋 雨"; // Isolated test data only.
const hash = value => createHash("sha256").update(value).digest("hex");
function account(name, secret = phrase) {
  return { id: name, email: hash("inou-username:" + name).slice(0, 48) + "@inou.app",
    user_metadata: { username: name, recovery: hash("recovery:" + name + ":" + secret) } };
}
async function scenario({ pages = [[account("旧账号")]], limited = false, listFailure = 0, updateFailure = false, config } = {}, callback) {
  const writes = [], reads = [];
  const app = express();
  app.use(express.json());
  app.post("/api/recover", createRecoveryHandler({
    config: config || (() => ({ url: "https://auth.example.test/", key: "test-server-only-key" })),
    limited: async () => limited,
    fetchAuth: async (url, options) => {
      assert.equal(options.headers.apikey, "test-server-only-key");
      if (options.method === "PUT") { writes.push({ url, body: JSON.parse(options.body) }); return Response.json({}, { status: updateFailure ? 500 : 200 }); }
      const page = Number(new URL(url).searchParams.get("page"));
      reads.push(page);
      return Response.json({ users: pages[page - 1] || [] }, { status: page === listFailure ? 500 : 200 });
    },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const request = async (body = { phrase, password: "new-test-password" }) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/recover`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(r.headers.get("cache-control"), "no-store");
    return { status: r.status, body: await r.json() };
  };
  try { await callback({ request, writes, reads }); } finally { await new Promise(resolve => server.close(resolve)); }
}

test("recovery needs only the existing eight-word key, normalizes whitespace and returns the account after reset", async () => {
  await scenario({}, async ({ request, writes }) => {
    const r = await request({ phrase: "  山\n海 星 月  春 风 秋 雨  ", password: "new-test-password" });
    assert.deepEqual(r, { status: 200, body: { ok: true, username: "旧账号" } });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].url, "https://auth.example.test/auth/v1/admin/users/" + encodeURIComponent("旧账号"));
    assert.deepEqual(writes[0].body, { password: "new-test-password" });
  });
});
test("wrong keys and invalid input never reset a user or reveal account details", async () => {
  await scenario({}, async ({ request, writes }) => {
    for (const body of [ {}, { phrase, password: "123" }, { phrase: [phrase], password: "long-password" }, { phrase: "错 错 错 错 错 错 错 错", password: "long-password" } ]) {
      const r = await request(body);
      assert.equal(r.status, 400);
      assert.equal(r.body.username, undefined);
    }
    assert.equal(writes.length, 0);
  });
});
test("matching account is found across pages; caller-supplied username cannot select a different account", async () => {
  await scenario({ pages: [Array.from({ length: 200 }, () => ({})), [account("匹配账号"), account("其他账号", "另 一 组 测 试 找 回 词")]] }, async ({ request, writes, reads }) => {
    const r = await request({ username: "其他账号", phrase, password: "new-test-password" });
    assert.equal(r.body.username, "匹配账号");
    assert.deepEqual(reads, [1, 2]);
    assert.equal(writes.length, 1);
  });
});
test("ambiguous keys, incomplete scans and identity-service errors fail without a reset", async () => {
  const full = [account("甲"), ...Array.from({ length: 199 }, () => ({}))];
  for (const options of [
    { pages: [full, [account("乙")]] },
    { pages: [full], listFailure: 2 },
    { pages: Array.from({ length: 20 }, () => full) },
  ]) await scenario(options, async ({ request, writes }) => {
    assert.ok((await request()).status >= 400);
    assert.equal(writes.length, 0);
  });
});
test("rate limiting and missing config fail before accessing accounts; rejected password writes are not reported as success", async () => {
  for (const options of [{ limited: true }, { config: () => ({}) }]) await scenario(options, async ({ request, writes, reads }) => {
    assert.ok((await request()).status >= 400);
    assert.equal(writes.length, 0); assert.equal(reads.length, 0);
  });
  await scenario({ updateFailure: true }, async ({ request }) => assert.equal((await request()).status, 502));
});
test("the existing frontend Supabase URL is a server fallback; the service role remains required", async () => {
  const previous = { SUPABASE_URL: process.env.SUPABASE_URL, VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  try {
    delete process.env.SUPABASE_URL;
    process.env.VITE_SUPABASE_URL = "https://auth.example.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-only-key";
    // Passing undefined uses the production config function.
    const handler = createRecoveryHandler({ limited: async () => false, fetchAuth: async url => {
      assert.ok(url.startsWith("https://auth.example.test/auth/v1/admin/users"));
      return Response.json({ users: [] });
    } });
    let status;
    await handler({ body: { phrase, password: "long-password" }, headers: {}, socket: {} }, {
      set() {}, status(s) { status = s; return this; }, json(body) { assert.equal(body.error, "找回密钥不正确或已失效"); },
    });
    assert.equal(status, 400);
  } finally { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});
test("new recovery keys have eight unique words and preserve the legacy hash format", async t => {
  let calls = 0;
  const original = crypto.getRandomValues.bind(crypto);
  t.mock.method(crypto, "getRandomValues", array => { calls++; return calls <= 4 ? array.fill(0) : original(array); });
  const words = generateRecoveryPhrase();
  assert.equal(words.length, 8); assert.equal(new Set(words).size, 8);
  assert.ok(words.every(word => word.length === 2));
  assert.ok(calls > 16); // The first duplicate was retried with fresh randomness.
  assert.equal(await recoveryHash("旧账号", "  山 海\n星 月 春 风 秋 雨 "), account("旧账号").user_metadata.recovery);
});
