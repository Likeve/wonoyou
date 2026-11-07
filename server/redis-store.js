import Redis from "ioredis";
import { createHash } from "node:crypto";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
const parseDevice = (raw) => {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return { publicKey: d.publicKey || "", name: d.name || "" };
  } catch {
    // Legacy plain public-key value.
    return { publicKey: raw, name: "" };
  }
};

// All keys share a hash tag, allowing atomic Lua operations on Redis clusters.
// Only metadata lives here. Signaling uses Pub/Sub, never lists or streams.
export function createRedisStore({ url, namespace = "inou-preview-v1" }) {
  if (!url) throw new Error("REDIS_URL is required for the cloud backend");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(namespace)) throw new Error("Invalid Redis namespace");
  const prefix = `{${namespace}}:`;
  const options = { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 10000,
    commandTimeout: 10000, enableOfflineQueue: false };
  const redis = new Redis(url, options), subscriber = new Redis(url, options);
  // Do not log connection objects/errors: they can contain credentials.
  redis.on("error", () => {});
  subscriber.on("error", () => {});
  const key = (s) => prefix + s;
  const channel = key("events");
  let starting;
  const listeners = new Set();
  subscriber.on("message", (_, message) => {
    try { const event = JSON.parse(message); for (const listener of listeners) listener(event); }
    catch { /* Ignore invalid transient events. */ }
  });
  async function ready() {
    if (!starting) starting = Promise.all([redis.connect(), subscriber.connect()])
      .then(() => subscriber.subscribe(channel));
    return starting;
  }
  const evalScript = (script, keys, args = []) => redis.eval(script, keys.length, ...keys.map(key), ...args);
  const store = {
    ready, redis, key,
    onEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async publish(event) { await redis.publish(channel, JSON.stringify(event)); },
    async limited(name, max = 60) {
      const count = await evalScript(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n`, ["limit:" + digest(name)]);
      return count > max;
    },
    async challenge(nonce, data) { await redis.set(key("challenge:" + nonce), JSON.stringify(data), "EX", 60); },
    async consumeChallenge(nonce) {
      const raw = await evalScript(`local v=redis.call('GET',KEYS[1]); redis.call('DEL',KEYS[1]); return v`, ["challenge:" + nonce]);
      return raw ? JSON.parse(raw) : null;
    },
    async createSession(token, device, name = "") {
      const payload = JSON.stringify({ publicKey: device.publicKey, name });
      await redis.multi().set(key("device:" + device.id), payload)
        .set(key("session:" + digest(token)), device.id, "EX", 43200).exec().then(checkTransaction);
    },
    async session(token) { return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? redis.get(key("session:" + digest(token))) : null; },
    async contacts(id) {
      const peers = await redis.smembers(key("friends:" + id));
      if (!peers.length) return [];
      const values = await redis.mget(...peers.flatMap(p => [key("device:" + p), key("presence:" + p)]));
      return peers.map((p, i) => {
        const d = parseDevice(values[i * 2]);
        return { id: p, publicKey: d?.publicKey, online: !!values[i * 2 + 1] };
      });
    },
    async device(id) {
      const raw = await redis.get(key("device:" + id));
      return raw ? parseDevice(raw) : null;
    },
    async blocked(id) { return redis.smembers(key("blocks:" + id)); },
    async related(a, b) {
      return !!(await evalScript(`return redis.call('SISMEMBER',KEYS[1],ARGV[1])==1 and redis.call('SISMEMBER',KEYS[2],ARGV[1])==0 and redis.call('SISMEMBER',KEYS[3],ARGV[2])==0 and 1 or 0`,
        ["friends:" + a, "blocks:" + a, "blocks:" + b], [b, a]));
    },
    async connect(a, b) {
      return evalScript(`
        local p=ARGV[1]
        if ARGV[2]==ARGV[3] then return {err='不能添加自己'} end
        if redis.call('EXISTS',p..'device:'..ARGV[3])==0 then return {err='找不到该身份码'} end
        if redis.call('SISMEMBER',p..'blocks:'..ARGV[2],ARGV[3])==1 or redis.call('SISMEMBER',p..'blocks:'..ARGV[3],ARGV[2])==1 then return {err='暂时无法添加对方'} end
        if redis.call('SISMEMBER',p..'friends:'..ARGV[2],ARGV[3])==1 then return ARGV[3] end
        if redis.call('SCARD',p..'friends:'..ARGV[2])>=100 or redis.call('SCARD',p..'friends:'..ARGV[3])>=100 then return {err='联系人数量已达上限'} end
        redis.call('SADD',p..'friends:'..ARGV[2],ARGV[3])
        redis.call('SADD',p..'friends:'..ARGV[3],ARGV[2])
        return ARGV[3]`, [], [prefix, a, b]);
    },
    async remove(id, peer, block) {
      const tx = redis.multi().srem(key("friends:" + id), peer).srem(key("friends:" + peer), id);
      if (block) tx.sadd(key("blocks:" + id), peer);
      checkTransaction(await tx.exec());
    },
    async unblock(id, peer) { await redis.srem(key("blocks:" + id), peer); },
    async claim(id, lease) { await redis.set(key("presence:" + id), lease, "EX", 75); },
    async owns(id, lease) { return (await redis.get(key("presence:" + id))) === lease; },
    async renew(id, lease) { return !!(await evalScript(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],75) end; return 0`, ["presence:" + id], [lease])); },
    async release(id, lease) { return !!(await evalScript(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`, ["presence:" + id], [lease])); },
    async close() { redis.disconnect(); subscriber.disconnect(); },
  };
  return store;
}

function checkTransaction(results) {
  for (const [error] of results || []) if (error) throw error;
  if (!results) throw new Error("Transaction not completed");
}
