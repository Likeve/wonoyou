import express from "express";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash, webcrypto, createHmac } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
const hash = (s) => createHash("sha256").update(s).digest("hex");
const error = (res, status, message) =>
  res.status(status).json({ error: message });
export function createApp({
  dbPath = ".data/metadata.sqlite",
  origin = process.env.APP_ORIGIN,
  staticDir = resolve("dist"),
} = {}) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, public_key TEXT NOT NULL, name TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS relations(a TEXT NOT NULL,b TEXT NOT NULL,PRIMARY KEY(a,b));
 CREATE TABLE IF NOT EXISTS blocks(owner TEXT NOT NULL,peer TEXT NOT NULL,PRIMARY KEY(owner,peer));`);
  if (
    !db
      .prepare("SELECT name FROM pragma_table_info('devices') WHERE name='name'")
      .get()
  )
    db.exec("ALTER TABLE devices ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  const app = express(),
    server = createServer(app),
    sockets = new Map(),
    sessions = new Map(),
    challenges = new Map(),
    limits = new Map();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    if (origin && req.headers.origin && req.headers.origin !== origin)
      return error(res, 403, "来源不允许");
    next();
  });
  app.use(express.json({ limit: "24kb" }));
  const limited = (key, max = 60) => {
    const now = Date.now();
    let v = limits.get(key);
    if (!v || v.until < now) v = { count: 0, until: now + 60000 };
    v.count++;
    limits.set(key, v);
    return v.count > max;
  };
  app.use("/api", (req, res, next) =>
    limited("ip:" + req.socket.remoteAddress, 240)
      ? error(res, 429, "操作太频繁，请稍后再试")
      : next(),
  );
  app.get("/api/health", (_, res) =>
    res.json({ ok: true, contentStorage: false }),
  );
  app.post("/api/challenge", async (req, res) => {
    try {
      const { publicKey } = req.body;
      if (typeof publicKey !== "string" || publicKey.length > 300)
        throw Error();
      await webcrypto.subtle.importKey(
        "spki",
        Buffer.from(publicKey, "base64"),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const id = hash(Buffer.from(publicKey, "base64")),
        nonce = randomBytes(32).toString("base64url");
      challenges.set(nonce, { id, publicKey, expires: Date.now() + 60000 });
      res.json({ nonce, id });
    } catch {
      error(res, 400, "设备公钥无效");
    }
  });
  app.post("/api/session", async (req, res) => {
    try {
      const { nonce, signature, name } = req.body,
        c = challenges.get(nonce);
      challenges.delete(nonce);
      if (!c || c.expires < Date.now()) return error(res, 401, "验证已过期");
      const key = await webcrypto.subtle.importKey(
        "spki",
        Buffer.from(c.publicKey, "base64"),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      if (
        !(await webcrypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          Buffer.from(signature, "base64"),
          Buffer.from("INOU-AUTH:" + nonce),
        ))
      )
        return error(res, 401, "设备验证失败");
      const displayName = typeof name === "string" ? name.trim().slice(0, 32) : "";
      db.prepare(
        `INSERT INTO devices(id, public_key, name) VALUES(?,?,?)
         ON CONFLICT(id) DO UPDATE SET public_key=excluded.public_key, name=excluded.name`,
      ).run(c.id, c.publicKey, displayName);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { id: c.id, expires: Date.now() + 12 * 3600000 });
      res.json({ token, id: c.id });
    } catch {
      error(res, 400, "设备验证失败");
    }
  });
  const auth = (req, res, next) => {
    const s = sessions.get(req.headers.authorization?.replace(/^Bearer /, ""));
    if (!s || s.expires < Date.now()) return error(res, 401, "请重新连接");
    req.deviceId = s.id;
    next();
  };
  app.use("/api", auth);
  const pair = (a, b) => [a, b].sort();
  const blocked = (a, b) =>
    !!db
      .prepare(
        "SELECT 1 FROM blocks WHERE (owner=? AND peer=?) OR (owner=? AND peer=?)",
      )
      .get(a, b, b, a);
  const related = (a, b) =>
    !!db
      .prepare("SELECT 1 FROM relations WHERE a=? AND b=?")
      .get(...pair(a, b)) && !blocked(a, b);
  const contacts = (id) =>
    db
      .prepare(
        "SELECT d.* FROM devices d JOIN relations r ON (r.a=d.id OR r.b=d.id) WHERE (r.a=? OR r.b=?) AND d.id!=?",
      )
      .all(id, id, id)
      .map((d) => ({
        id: d.id,
        publicKey: d.public_key,
        online: sockets.has(d.id),
      }));
  const send = (id, data) => {
    const ws = sockets.get(id);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  };
  let stopping = false;
  const notify = () => {
    if (stopping) return;
    for (const id of sockets.keys())
      send(id, { type: "contacts", contacts: contacts(id) });
  };
  app.get("/api/contacts", (req, res) =>
    res.json({
      contacts: contacts(req.deviceId),
      blocked: db
        .prepare("SELECT peer FROM blocks WHERE owner=?")
        .all(req.deviceId)
        .map((v) => v.peer),
    }),
  );
  app.get("/api/identity/:id", (req, res) => {
    if (limited("lookup:" + req.deviceId, 60))
      return error(res, 429, "尝试过多，请稍后再试");
    const id = String(req.params.id || "")
      .toLowerCase()
      .replace(/[^0-9a-f]/g, "");
    if (!/^[0-9a-f]{64}$/.test(id))
      return error(res, 400, "身份码格式不正确");
    const d = db.prepare("SELECT id, name FROM devices WHERE id=?").get(id);
    if (!d) return error(res, 400, "找不到该身份码，请确认对方已上线");
    res.json({ id: d.id, name: d.name || "" });
  });
  app.post("/api/contacts", (req, res) => {
    if (limited("add:" + req.deviceId, 10))
      return error(res, 429, "尝试过多，请稍后再试");
    const peer = String(req.body.id || "")
      .toLowerCase()
      .replace(/[^0-9a-f]/g, "");
    if (!/^[0-9a-f]{64}$/.test(peer))
      return error(res, 400, "身份码格式不正确");
    const id = req.deviceId;
    if (peer === id) return error(res, 400, "不能添加自己");
    if (!db.prepare("SELECT 1 FROM devices WHERE id=?").get(peer))
      return error(res, 400, "找不到该身份码，请确认对方已上线");
    if (blocked(id, peer)) return error(res, 400, "暂时无法添加对方");
    if (related(id, peer)) return res.json({ id: peer });
    if (contacts(id).length >= 100 || contacts(peer).length >= 100)
      return error(res, 400, "联系人数量已达上限");
    db.prepare("INSERT OR IGNORE INTO relations VALUES(?,?)").run(
      ...pair(id, peer),
    );
    res.json({ id: peer });
    notify();
  });
  app.delete("/api/contacts/:peer", (req, res) => {
    const id = req.deviceId,
      p = req.params.peer;
    db.prepare("DELETE FROM relations WHERE a=? AND b=?").run(...pair(id, p));
    if (req.query.block === "true")
      db.prepare("INSERT OR IGNORE INTO blocks VALUES(?,?)").run(id, p);
    res.json({ ok: true });
    notify();
  });
  app.delete("/api/blocks/:peer", (req, res) => {
    db.prepare("DELETE FROM blocks WHERE owner=? AND peer=?").run(
      req.deviceId,
      req.params.peer,
    );
    res.json({ ok: true });
  });
  app.get("/api/ice", (req, res) => {
    const iceServers = [
      { urls: process.env.STUN_URL || "stun:stun.l.google.com:19302" },
    ];
    if (process.env.TURN_URL && process.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${req.deviceId}`;
      iceServers.push({
        urls: process.env.TURN_URL.split(","),
        username,
        credential: createHmac("sha1", process.env.TURN_SECRET)
          .update(username)
          .digest("base64"),
      });
    }
    res.json({ iceServers, relayConfigured: !!process.env.TURN_SECRET });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 24000 });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/signal" || (origin && req.headers.origin !== origin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    let id,
      authTimer = setTimeout(() => ws.close(), 5000);
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    ws.on("message", (buf) => {
      try {
        const m = JSON.parse(buf.toString());
        if (!id) {
          const s = m.type === "auth" && sessions.get(m.token);
          if (!s || s.expires < Date.now()) return ws.close();
          id = s.id;
          clearTimeout(authTimer);
          sockets.get(id)?.close(4001, "another session");
          sockets.set(id, ws);
          notify();
          return;
        }
        if (limited("ws:" + id, 300)) return ws.close(1008);
        if (
          m.type === "signal" &&
          typeof m.to === "string" &&
          related(id, m.to) &&
          typeof m.payload === "string" &&
          m.payload.length <= 18000 &&
          typeof m.signature === "string"
        )
          send(m.to, {
            type: "signal",
            from: id,
            payload: m.payload,
            signature: m.signature,
          });
      } catch {
        ws.close(1008);
      }
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (sockets.get(id) === ws) {
        sockets.delete(id);
        notify();
      }
    });
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const map of [sessions, challenges])
      for (const [k, v] of map) if (v.expires < now) map.delete(k);
    for (const [k, v] of limits) if (v.until < now) limits.delete(k);
  }, 30000);
  timer.unref();
  app.use("/api", (_, res) => error(res, 404, "接口不存在"));
  app.use(express.static(staticDir, { index: false }));
  app.get("/{*path}", (_, res) =>
    res.sendFile(resolve(staticDir, "index.html")),
  );
  app.use((err, req, res, next) =>
    error(res, err.status || 500, "请求未完成，请重试"),
  );
  return {
    app,
    server,
    db,
    close: async () => {
      stopping = true;
      clearInterval(timer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => server.close(r));
      db.close();
    },
  };
}
