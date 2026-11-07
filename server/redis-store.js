import Redis from "ioredis";
import { createHash } from "node:crypto";

export const digest = (value) => createHash("sha256").update(value).digest("hex");

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
    async createSession(token, device) {
      await redis.multi().set(key("device:" + device.id), device.publicKey, "NX")
        .set(key("session:" + digest(token)), device.id, "EX", 43200).exec().then(checkTransaction);
    },
    async session(token) { return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token)
      ? redis.get(key("session:" + digest(token))) : null; },
    async contacts(id) {
      const peers = await redis.smembers(key("friends:" + id));
      if (!peers.length) return [];
      const values = await redis.mget(...peers.flatMap(p => [key("device:" + p), key("presence:" + p)]));
      return peers.map((p, i) => ({ id: p, publicKey: values[i * 2], online: !!values[i * 2 + 1] }));
    },
    async blocked(id) { return redis.smembers(key("blocks:" + id)); },
    async related(a, b) {
      return !!(await evalScript(`return redis.call('SISMEMBER',KEYS[1],ARGV[1])==1 and redis.call('SISMEMBER',KEYS[2],ARGV[1])==0 and redis.call('SISMEMBER',KEYS[3],ARGV[2])==0 and 1 or 0`,
        ["friends:" + a, "blocks:" + a, "blocks:" + b], [b, a]));
    },
    async invite(hash, owner) {
      await evalScript(`local g=redis.call('GET',KEYS[2]) or '0'; redis.call('HSET',KEYS[1],'owner',ARGV[1],'generation',g); redis.call('EXPIRE',KEYS[1],86400); return 1`,
        ["invite:" + hash, "generation:" + owner], [owner]);
    },
    async revokeInvites(id) { await redis.incr(key("generation:" + id)); },
    async redeem(hash, id) {
      return evalScript(`
        local owner=redis.call('HGET',KEYS[1],'owner')
        if not owner or owner==ARGV[1] then return {err='邀请码不可用'} end
        local p=ARGV[2]
        if redis.call('SISMEMBER',p..'blocks:'..owner,ARGV[1])==1 or redis.call('SISMEMBER',p..'blocks:'..ARGV[1],owner)==1 then return {err='邀请码不可用'} end
        local used=redis.call('HGET',KEYS[1],'used_by')
        if used and used~=ARGV[1] then return {err='邀请码不可用'} end
        local related=redis.call('SISMEMBER',p..'friends:'..owner,ARGV[1])==1
        if used then
          if related then return owner else return {err='请使用新的邀请码'} end
        end
        if (redis.call('GET',p..'generation:'..owner) or '0')~=redis.call('HGET',KEYS[1],'generation') then return {err='邀请码不可用'} end
        if not related and (redis.call('SCARD',p..'friends:'..owner)>=100 or redis.call('SCARD',p..'friends:'..ARGV[1])>=100) then return {err='联系人数量已达上限'} end
        redis.call('HSET',KEYS[1],'used_by',ARGV[1])
        redis.call('SADD',p..'friends:'..owner,ARGV[1])
        redis.call('SADD',p..'friends:'..ARGV[1],owner)
        return owner`, ["invite:" + hash], [id, prefix]);
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
