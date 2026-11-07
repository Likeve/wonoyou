import express from "express";
import { createServer } from "node:http";
import { randomBytes, randomUUID, webcrypto, createHmac } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { resolve } from "node:path";
import { createRedisStore, digest } from "./redis-store.js";

const validId = (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const fail = (res, status, message) => res.status(status).json({ error: message });
const importKey = (publicKey) => webcrypto.subtle.importKey("spki", Buffer.from(publicKey, "base64"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);

export function createCloudApp({
  url = process.env.REDIS_URL || process.env.KV_URL,
  namespace = process.env.REDIS_NAMESPACE || "inou-preview-v1",
  origin = process.env.APP_ORIGIN,
  staticDir,
} = {}) {
  const store = createRedisStore({ url, namespace });
  const app = express(), server = createServer(app), sockets = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 24000 });
  let stopping = false;
  const allowedOrigin = (req) => {
    const source = req.headers.origin;
    if (!source) return false;
    const allowed = [origin, process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`].filter(Boolean);
    return allowed.length ? allowed.includes(source) : !process.env.VERCEL && source === `http://${req.headers.host}`;
  };
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
    if (req.headers.origin && !allowedOrigin(req)) return fail(res, 403, "来源不允许");
    next();
  });
  app.use(express.json({ limit: "24kb" }));
  app.use("/api", async (req, res, next) => {
    await store.ready();
    // Vercel overwrites this header at its edge. Never trust it on the local server.
    const ip = process.env.VERCEL ? req.headers["x-vercel-forwarded-for"] || req.socket.remoteAddress : req.socket.remoteAddress;
    if (await store.limited("ip:" + ip, 240)) return fail(res, 429, "操作太频繁，请稍后再试");
    next();
  });
  app.get("/api/health", async (_, res) => {
    await store.redis.ping();
    res.json({ ok: true, contentStorage: false, backend: "redis" });
  });
  app.post("/api/challenge", async (req, res) => {
    const publicKey = req.body?.publicKey;
    if (typeof publicKey !== "string" || publicKey.length > 300) return fail(res, 400, "设备公钥无效");
    try { await importKey(publicKey); } catch { return fail(res, 400, "设备公钥无效"); }
    const id = digest(Buffer.from(publicKey, "base64")), nonce = randomBytes(32).toString("base64url");
    await store.challenge(nonce, { id, publicKey });
    res.json({ nonce, id });
  });
  app.post("/api/session", async (req, res) => {
    const { nonce, signature } = req.body || {};
    if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || typeof signature !== "string" || signature.length > 200)
      return fail(res, 400, "设备验证失败");
    const device = await store.consumeChallenge(nonce);
    if (!device) return fail(res, 401, "验证已过期");
    let verified = false;
    try { verified = await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await importKey(device.publicKey), Buffer.from(signature, "base64"), Buffer.from("INOU-AUTH:" + nonce)); } catch { /* Invalid proof. */ }
    if (!verified) return fail(res, 401, "设备验证失败");
    const token = randomBytes(32).toString("base64url");
    await store.createSession(token, device);
    res.json({ token, id: device.id });
  });
  app.use("/api", async (req, res, next) => {
    const id = await store.session(req.headers.authorization?.replace(/^Bearer /, ""));
    if (!id) return fail(res, 401, "请重新连接");
    req.deviceId = id;
    next();
  });
  const send = (ws, data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); };
  const refresh = async (id) => {
    const ws = sockets.get(id);
    if (ws) send(ws, { type: "contacts", contacts: await store.contacts(id) });
  };
  const refreshAll = () => Promise.all([...sockets.keys()].map(refresh));
  const eventHandler = async (event) => {
    if (stopping) return;
    if (event.type === "signal") {
      const ws = sockets.get(event.to);
      if (ws && await store.owns(event.to, ws.lease) && await store.related(event.from, event.to))
        send(ws, { type: "signal", from: event.from, payload: event.payload, signature: event.signature });
    } else if (event.type === "presence") {
      const ws = sockets.get(event.id);
      if (ws && !await store.owns(event.id, ws.lease)) ws.close(4001, "another session");
      await refreshAll();
    } else if (event.type === "contacts") {
      await Promise.all(event.ids.filter(validId).map(refresh));
    }
  };
  let eventQueue = Promise.resolve();
  store.onEvent(event => {
    // Preserve SDP/ICE ordering even when Redis permission checks take different times.
    eventQueue = eventQueue.then(() => eventHandler(event)).catch(() => {});
  });
  app.get("/api/contacts", async (req, res) => res.json({
    contacts: await store.contacts(req.deviceId), blocked: await store.blocked(req.deviceId),
  }));
  app.post("/api/contacts", async (req, res) => {
    if (await store.limited("add:" + req.deviceId, 10)) return fail(res, 429, "尝试过多，请稍后再试");
    const peer = String(req.body?.id || "").toLowerCase().replace(/[^0-9a-f]/g, "");
    if (!/^[0-9a-f]{64}$/.test(peer)) return fail(res, 400, "身份码格式不正确");
    try { await store.connect(req.deviceId, peer); }
    catch (e) {
      if (/找不到该身份码|不能添加自己|暂时无法添加对方|联系人数量已达上限/.test(e.message)) return fail(res, 400, e.message.replace(/^ERR /, ""));
      throw e;
    }
    await store.publish({ type: "contacts", ids: [req.deviceId, peer] });
    res.json({ id: peer });
  });
  app.delete("/api/contacts/:peer", async (req, res) => {
    if (!validId(req.params.peer)) return fail(res, 400, "联系人无效");
    await store.remove(req.deviceId, req.params.peer, req.query.block === "true");
    await store.publish({ type: "contacts", ids: [req.deviceId, req.params.peer] });
    res.json({ ok: true });
  });
  app.delete("/api/blocks/:peer", async (req, res) => {
    if (!validId(req.params.peer)) return fail(res, 400, "联系人无效");
    await store.unblock(req.deviceId, req.params.peer); res.json({ ok: true });
  });
  app.get("/api/ice", (req, res) => {
    const iceServers = [];
    if (process.env.STUN_URL) iceServers.push({ urls: process.env.STUN_URL.split(",") });
    const relayConfigured = !!(process.env.TURN_URL && process.env.TURN_SECRET);
    if (relayConfigured) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${req.deviceId}`;
      iceServers.push({ urls: process.env.TURN_URL.split(","), username,
        credential: createHmac("sha1", process.env.TURN_SECRET).update(username).digest("base64") });
    }
    res.json({ iceServers, relayConfigured });
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] !== "/signal" || !allowedOrigin(req)) return socket.destroy();
    store.ready().then(() => {
      if (!socket.destroyed) wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
    }).catch(() => socket.destroy());
  });
  wss.on("connection", (ws) => {
    let id, token, chain = Promise.resolve();
    ws.lease = randomUUID(); ws.alive = true;
    const authTimer = setTimeout(() => ws.close(1008), 5000);
    ws.on("pong", () => { ws.alive = true; });
    const handle = async (buf) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const m = JSON.parse(buf.toString());
      if (!id) {
        const sessionId = m.type === "auth" && await store.session(m.token);
        if (!sessionId) return ws.close(1008);
        // Recheck after each await: a closed connection must not reclaim presence.
        if (ws.readyState !== WebSocket.OPEN) return;
        id = sessionId; token = m.token;
        sockets.get(id)?.close(4001, "another session");
        sockets.set(id, ws);
        await store.claim(id, ws.lease);
        clearTimeout(authTimer);
        if (ws.readyState !== WebSocket.OPEN) { await store.release(id, ws.lease); return; }
        await store.publish({ type: "presence", id });
        await refresh(id);
        return;
      }
      if (await store.limited("ws:" + id, 300)) return ws.close(1008);
      if (!await store.owns(id, ws.lease)) return ws.close(4001);
      if (m.type === "signal" && validId(m.to) && typeof m.payload === "string" && m.payload.length <= 18000 &&
        typeof m.signature === "string" && m.signature.length <= 200 && await store.related(id, m.to))
        await store.publish({ type: "signal", to: m.to, from: id, payload: m.payload, signature: m.signature });
    };
    let queued = 0;
    ws.on("message", buf => {
      if (++queued > 50) { ws.close(1008); return; }
      chain = chain.then(() => handle(buf)).catch(() => ws.close(1011)).finally(() => queued--);
    });
    ws.on("error", () => {});
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (sockets.get(id) === ws) sockets.delete(id);
      if (id) store.release(id, ws.lease).then(changed => changed && store.publish({ type: "presence", id })).catch(() => {});
    });
    ws.checkSession = async () => {
      if (!id) return;
      if (!await store.session(token) || !await store.renew(id, ws.lease)) { ws.close(4001); return; }
      await refresh(id);
    };
  });
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || stopping) return;
    checking = true;
    try {
      await Promise.all([...wss.clients].map(async ws => {
        if (!ws.alive) return ws.terminate();
        ws.alive = false;
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        try { await ws.checkSession(); } catch { ws.close(1011); }
      }));
    } finally { checking = false; }
  }, 25000);
  timer.unref();
  app.use("/api", (_, res) => fail(res, 404, "接口不存在"));
  if (staticDir) {
    app.use(express.static(staticDir, { index: false }));
    app.get("/{*path}", (_, res) => res.sendFile(resolve(staticDir, "index.html")));
  }
  app.use((err, req, res, next) => fail(res, err.status || 503, "服务暂不可用，请稍后重连"));
  return { app, server, store, async close() {
    stopping = true; clearInterval(timer);
    for (const [id, ws] of sockets) await store.release(id, ws.lease).catch(() => {});
    for (const ws of wss.clients) ws.terminate();
    await new Promise(r => server.close(r));
    await store.close();
  } };
}
