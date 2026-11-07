import {
  signingKey,
  sign,
  verify,
  digest,
  from64,
  validMessage,
} from "./vault";
export class ChatEngine {
  constructor(vault, onChange, onError) {
    this.vault = vault;
    this.state = vault.state;
    this.state.relationOps ||= [];
    this.onChange = onChange;
    this.onError = onError;
    this.peers = new Map();
    this.online = new Set();
    this.running = false;
    this.connected = false;
    this.token = null;
    this.iceServers = [];
    this.relayConfigured = false;
    this.receiveQueue = Promise.resolve();
    this.syncQueue = Promise.resolve();
    this.retrying = false;
  }
  emit() {
    this.onChange();
  }
  async api(path, method = "GET", body) {
    const r = await fetch("/api/" + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json();
    if (!r.ok) {
      if (r.status === 401) this.token = null;
      throw Error(d.error || "连接失败");
    }
    return d;
  }
  async start() {
    this.key = await signingKey(this.state.identity);
    this.running = true;
    await this.connect();
    this.timer = setInterval(() => this.tick(), 5000);
    this.network = () => this.tick();
    window.addEventListener("online", this.network);
  }
  async connect() {
    if (
      !this.running ||
      this.retrying ||
      this.ws?.readyState === WebSocket.OPEN
    )
      return;
    this.retrying = true;
    try {
      const c = await this.api("challenge", "POST", {
        publicKey: this.state.identity.publicKey,
      });
      const session = await this.api("session", "POST", {
        nonce: c.nonce,
        signature: await sign(this.key, "INOU-AUTH:" + c.nonce),
      });
      if (!this.running) return;
      this.token = session.token;
      const ice = await this.api("ice");
      this.iceServers = ice.iceServers;
      this.relayConfigured = ice.relayConfigured;
      const ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/signal`,
      );
      this.ws = ws;
      ws.onopen = () => {
        if (!this.running) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: "auth", token: this.token }));
      };
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "contacts") {
          this.connected = true;
          this.syncQueue = this.syncQueue
            .then(() => this.mergeContacts(m.contacts))
            .catch((e) => this.onError(e.message));
        }
        if (m.type === "signal") this.handleSignal(m).catch(() => {});
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.online.clear();
        for (const id of [...this.peers.keys()]) this.drop(id);
        this.emit();
      };
      ws.onerror = () => {};
    } catch {
      this.connected = false;
      this.emit();
    } finally {
      this.retrying = false;
    }
  }
  async mergeContacts(list) {
    if (!this.running) return;
    const old = structuredClone(this.state.contacts);
    this.online = new Set(list.filter((x) => x.online).map((x) => x.id));
    for (const c of this.state.contacts) c.active = false;
    for (const remote of list) {
      if ((await digest(from64(remote.publicKey))) !== remote.id) continue;
      let c = this.state.contacts.find((x) => x.id === remote.id);
      if (c && c.publicKey && c.publicKey !== remote.publicKey) {
        c.keyChanged = true;
        continue;
      }
      if (!c) {
        c = {
          id: remote.id,
          name: "新朋友",
          publicKey: remote.publicKey,
          active: true,
        };
        this.state.contacts.push(c);
      } else {
        c.publicKey = remote.publicKey;
        c.active =
          !c.blocked &&
          !c.keyChanged &&
          !this.state.relationOps.some((op) => op.peer === c.id);
      }
    }
    for (const [id] of this.peers)
      if (
        !this.state.contacts.find((c) => c.id === id && c.active) ||
        !this.online.has(id)
      )
        this.drop(id);
    try {
      await this.vault.save();
    } catch (e) {
      this.state.contacts = old;
      throw e;
    }
    this.emit();
    await this.tick();
  }
  drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    p.pc.close();
    this.emit();
  }
  async signal(id, data) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify({
      ...data,
      to: id,
      from: this.state.identity.id,
      time: Date.now(),
    });
    const signature = await sign(this.key, payload);
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(
        JSON.stringify({ type: "signal", to: id, payload, signature }),
      );
  }
  makePeer(id, call) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers }),
      p = {
        pc,
        call,
        created: Date.now(),
        chunks: new Map(),
        sending: false,
        candidates: [],
      };
    this.peers.set(id, p);
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.signal(id, {
          kind: "ice",
          call,
          candidate: e.candidate.toJSON(),
        }).catch(() => {});
    };
    pc.ondatachannel = (e) => this.attach(id, p, e.channel);
    pc.onconnectionstatechange = () => {
      if (
        ["closed", "failed"].includes(pc.connectionState) &&
        this.peers.get(id) === p
      )
        this.drop(id);
      this.emit();
    };
    return p;
  }
  async offer(id) {
    if (this.peers.has(id) || this.peers.size >= 3) return;
    const p = this.makePeer(id, crypto.randomUUID());
    this.attach(id, p, p.pc.createDataChannel("inou-v1", { ordered: true }));
    await p.pc.setLocalDescription(await p.pc.createOffer());
    await this.signal(id, {
      kind: "offer",
      call: p.call,
      description: {
        type: p.pc.localDescription.type,
        sdp: p.pc.localDescription.sdp,
      },
    });
  }
  async handleSignal(m) {
    if (!this.running) return;
    const c = this.state.contacts.find((c) => c.id === m.from && c.active);
    if (!c || !(await verify(c.publicKey, m.payload, m.signature))) return;
    const d = JSON.parse(m.payload);
    if (
      d.from !== m.from ||
      d.to !== this.state.identity.id ||
      Math.abs(Date.now() - d.time) > 60000 ||
      typeof d.call !== "string"
    )
      return;
    let p = this.peers.get(m.from);
    if (d.kind === "offer") {
      if (
        m.from > this.state.identity.id ||
        p?.channel?.readyState === "open" ||
        (this.peers.size >= 3 && !p)
      )
        return;
      if (p) this.drop(m.from);
      p = this.makePeer(m.from, d.call);
      await p.pc.setRemoteDescription(d.description);
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      await this.signal(m.from, {
        kind: "answer",
        call: d.call,
        description: {
          type: p.pc.localDescription.type,
          sdp: p.pc.localDescription.sdp,
        },
      });
    } else if (p && p.call === d.call) {
      if (d.kind === "answer" && p.pc.signalingState === "have-local-offer") {
        await p.pc.setRemoteDescription(d.description);
        for (const c of p.candidates) await p.pc.addIceCandidate(c);
        p.candidates = [];
      } else if (d.kind === "ice") {
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.candidate);
        else p.candidates.push(d.candidate);
      }
    }
  }
  attach(id, p, ch) {
    p.channel = ch;
    ch.bufferedAmountLowThreshold = 65536;
    ch.onopen = () => {
      ch.send(
        JSON.stringify({ type: "profile", name: this.state.identity.name }),
      );
      this.emit();
      this.flush(id).catch((e) => this.onError(e.message));
    };
    ch.onclose = () => {
      if (this.peers.get(id) === p) this.drop(id);
    };
    ch.onmessage = (e) => {
      this.receiveQueue = this.receiveQueue
        .then(() => this.receive(id, p, e.data))
        .catch((e) => this.onError(e.message));
    };
  }
  async receive(id, p, raw) {
    if (
      !this.running ||
      !this.state.contacts.find((c) => c.id === id && c.active) ||
      typeof raw !== "string" ||
      raw.length > 20000
    )
      return;
    const m = JSON.parse(raw);
    if (m.type === "profile" && typeof m.name === "string") {
      const c = this.state.contacts.find((c) => c.id === id);
      c.name = m.name.slice(0, 32);
      await this.vault.save();
      this.emit();
      return;
    }
    if (m.type === "ack") {
      const message = this.state.messages.find(
        (x) =>
          x.id === m.id &&
          x.peer === id &&
          x.sender === this.state.identity.id &&
          x.status === "pending",
      );
      if (message) {
        message.status = "delivered";
        try {
          await this.vault.save();
        } catch (e) {
          message.status = "pending";
          throw e;
        }
        this.emit();
      }
      return;
    }
    if (
      m.type !== "part" ||
      typeof m.id !== "string" ||
      m.id.length > 100 ||
      !Number.isInteger(m.index) ||
      !Number.isInteger(m.total) ||
      m.total < 1 ||
      m.total > 240 ||
      m.index < 0 ||
      m.index >= m.total ||
      typeof m.data !== "string" ||
      m.data.length > 14000
    )
      return;
    if (p.chunks.size >= 3 && !p.chunks.has(m.id)) return;
    let parts = p.chunks.get(m.id);
    if (!parts) {
      parts = { total: m.total, values: new Map(), created: Date.now() };
      p.chunks.set(m.id, parts);
    }
    if (parts.total !== m.total) return;
    parts.values.set(m.index, m.data);
    if (parts.values.size !== parts.total) return;
    p.chunks.delete(m.id);
    const data = Array.from({ length: parts.total }, (_, i) =>
        parts.values.get(i),
      ).join(""),
      message = JSON.parse(data);
    if (!validMessage(message) || message.id !== m.id) return;
    const seen = id + ":" + message.id;
    if (!this.state.seen.includes(seen)) {
      const received = { ...message, peer: id, sender: id, status: "received" };
      this.state.messages.push(received);
      this.state.seen.push(seen);
      try {
        await this.vault.save();
      } catch (e) {
        this.state.messages = this.state.messages.filter((x) => x !== received);
        this.state.seen = this.state.seen.filter((x) => x !== seen);
        throw Error("本机存储失败，消息尚未确认送达");
      }
      this.emit();
    }
    if (p.channel?.readyState === "open")
      p.channel.send(JSON.stringify({ type: "ack", id: m.id }));
  }
  async send(peer, body, kind = "text") {
    if (!this.state.contacts.find((c) => c.id === peer && c.active))
      throw Error("当前好友关系不可用");
    const m = {
      id: crypto.randomUUID(),
      peer,
      sender: this.state.identity.id,
      time: Date.now(),
      body,
      kind,
      status: "pending",
    };
    if (!validMessage(m)) throw Error("消息格式或长度不支持");
    this.state.messages.push(m);
    const draft = this.state.drafts[peer];
    delete this.state.drafts[peer];
    try {
      await this.vault.save();
    } catch (e) {
      this.state.messages = this.state.messages.filter((x) => x !== m);
      this.state.drafts[peer] = draft;
      throw Error("本地保存失败，请检查剩余空间");
    }
    this.emit();
    this.flush(peer).catch(() => {});
    return m;
  }
  async flush(id) {
    const p = this.peers.get(id);
    if (!p || p.sending || p.channel?.readyState !== "open") return;
    p.sending = true;
    try {
      for (const m of this.state.messages.filter(
        (m) => m.peer === id && m.status === "pending",
      )) {
        if (
          !this.running ||
          !this.state.contacts.find((c) => c.id === id && c.active)
        )
          break;
        const value = JSON.stringify({
            id: m.id,
            body: m.body,
            kind: m.kind,
            time: m.time,
          }),
          size = 12000,
          total = Math.ceil(value.length / size);
        for (let index = 0; index < total; index++) {
          if (p.channel.readyState !== "open") return;
          if (p.channel.bufferedAmount > 262144)
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                p.channel.removeEventListener("bufferedamountlow", done);
                reject(Error("传输中断"));
              }, 5000);
              const done = () => {
                clearTimeout(timer);
                resolve();
              };
              p.channel.addEventListener("bufferedamountlow", done, {
                once: true,
              });
            });
          p.channel.send(
            JSON.stringify({
              type: "part",
              id: m.id,
              index,
              total,
              data: value.slice(index * size, (index + 1) * size),
            }),
          );
        }
      }
    } finally {
      p.sending = false;
    }
  }
  async tick() {
    if (!this.running || document.visibilityState === "hidden") return;
    if (!this.connected) {
      await this.connect();
      return;
    }
    await this.flushRelations();
    for (const [id, p] of this.peers) {
      if (p.channel?.readyState !== "open" && Date.now() - p.created > 20000)
        this.drop(id);
      for (const [key, c] of p.chunks)
        if (Date.now() - c.created > 60000) p.chunks.delete(key);
    }
    for (const c of this.state.contacts) {
      if (!c.active || !this.online.has(c.id)) continue;
      if (this.state.identity.id < c.id && !this.peers.has(c.id))
        await this.offer(c.id).catch(() => this.drop(c.id));
      await this.flush(c.id).catch(() => {});
    }
  }
  async refresh() {
    const d = await this.api("contacts");
    this.state.blocked = d.blocked;
    await this.mergeContacts(d.contacts);
  }
  async remove(peer, block = false) {
    const old = structuredClone(this.state);
    const c = this.state.contacts.find((c) => c.id === peer);
    c.active = false;
    c.blocked = block;
    for (const m of this.state.messages)
      if (m.peer === peer && m.status === "pending") m.status = "cancelled";
    this.state.relationOps = this.state.relationOps.filter(
      (op) => op.peer !== peer,
    );
    this.state.relationOps.push({ peer, block });
    try {
      await this.vault.save();
    } catch (e) {
      Object.assign(this.state, old);
      throw e;
    }
    this.drop(peer);
    this.emit();
    await this.flushRelations();
    return !this.state.relationOps.some((op) => op.peer === peer);
  }
  async flushRelations() {
    if (
      !this.connected ||
      this.flushingRelations ||
      !this.state.relationOps.length
    )
      return;
    this.flushingRelations = true;
    try {
      for (const op of [...this.state.relationOps]) {
        await this.api(
          "contacts/" + op.peer + (op.block ? "?block=true" : ""),
          "DELETE",
        );
        this.state.relationOps = this.state.relationOps.filter(
          (item) => item !== op,
        );
        await this.vault.save();
      }
    } catch {
      // Keep the durable local operation queued until the service is reachable.
    } finally {
      this.flushingRelations = false;
      this.emit();
    }
  }
  stop() {
    this.running = false;
    clearInterval(this.timer);
    window.removeEventListener("online", this.network);
    this.ws?.close();
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.token = null;
    this.key = null;
  }
}
