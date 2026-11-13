import {
  signingKey,
  sign,
  verify,
  digest,
  from64,
  validMessage,
  sealMailbox,
  openMailbox,
} from "./vault";

const urlBase64ToUint8Array = (base64) => {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export class ChatEngine {
  constructor(vault, onChange, onError) {
    this.vault = vault;
    this.state = vault.state;
    this.state.relationOps ||= [];
    this.state.groups ||= [];
    this.onChange = onChange;
    this.onError = onError;
    this.peers = new Map();
    this.online = new Set();
    this.running = false;
    this.connected = false;
    this.token = null;
    this.iceServers = [];
    this.relayConfigured = false;
    this.vapidPublicKey = "";
    this.receiveQueue = Promise.resolve();
    this.syncQueue = Promise.resolve();
    this.retrying = false;
    this.lastMailbox = 0;
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
    this.swMessage = (e) => {
      if (e.data?.type === "inou-push") this.fetchMailbox().catch(() => {});
    };
    navigator.serviceWorker?.addEventListener("message", this.swMessage);
    this.fetchMailbox().catch(() => {});
    // The browser subscription can outlive the server record or a deployment.
    // Re-register it on every start so background notifications self-heal.
    if (typeof Notification !== "undefined" && Notification.permission === "granted")
      this.subscribePush().catch(() => {});
    this.timer = setInterval(() => this.tick().catch(() => {}), 5000);
    this.network = () => this.tick().catch(() => {});
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
        name: this.state.identity.name,
      });
      if (!this.running) return;
      this.token = session.token;
      await this.syncGroups();
      const ice = await this.api("ice");
      this.iceServers = ice.iceServers;
      this.relayConfigured = ice.relayConfigured;
      this.vapidPublicKey = ice.vapidPublicKey || "";
      this.emit();
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
        if (m.type === "groups-changed") this.syncGroups().then(() => this.fetchMailbox()).catch(e => this.onError(e.message));
        if (m.type === "mailbox-changed") this.fetchMailbox().catch(e => this.onError(e.message));
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
          name: remote.name || "新朋友",
          publicKey: remote.publicKey,
          active: true,
        };
        this.state.contacts.push(c);
      } else {
        c.publicKey = remote.publicKey;
        if (typeof remote.name === "string" && remote.name)
          c.name = remote.name;
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
          (x.status === "pending" || x.status === "sent"),
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
      this.notifyHidden(id, message);
    }
    if (p.channel?.readyState === "open")
      p.channel.send(JSON.stringify({ type: "ack", id: m.id }));
  }
  async syncGroups() {
    if (this.groupsSync) return this.groupsSync;
    this.groupsSync = (async () => {
      const { groups } = await this.api("groups");
      const next = [];
      for (const group of groups) {
        if (!group.members.some(m => m.id === this.state.identity.id)) continue;
        let valid = true;
        for (const m of group.members) if (await digest(from64(m.publicKey)) !== m.id) valid = false;
        if (!valid) continue;
        const old = this.state.groups.find(g => g.id === group.id);
        next.push({ ...old, ...group, isGroup: true, active: true });
      }
      this.state.groups = [...next, ...this.state.groups.filter(old => !next.some(g => g.id === old.id)).map(g => ({ ...g, active: false }))];
      await this.vault.save();
      this.emit();
    })().finally(() => { this.groupsSync = null; });
    return this.groupsSync;
  }
  async createGroup(name, members, groupId) {
    const result = await this.api(groupId ? `groups/${groupId}/members` : "groups", "POST", { name, members });
    await this.syncGroups();
    return result.group.id;
  }
  async sendGroup(peer, body, kind) {
    const group = this.state.groups.find(g => g.id === peer);
    if (!group?.active) throw Error("群聊不可用");
    const message = { id: crypto.randomUUID(), peer, groupId: peer, sender: this.state.identity.id,
      time: Date.now(), body, kind, status: "pending", recipients: group.members.filter(m => m.id !== this.state.identity.id).map(m => m.id), posted: [] };
    if (!validMessage(message)) throw Error("消息格式或长度不支持");
    const draft = this.state.drafts[peer];
    this.state.messages.push(message);
    delete this.state.drafts[peer];
    try { await this.vault.save(); } catch (e) {
      this.state.messages = this.state.messages.filter(m => m !== message);
      this.state.drafts[peer] = draft;
      throw e;
    }
    this.emit();
    this.flushGroups().catch(e => this.onError(e.message));
    return message;
  }
  async flushGroups() {
    if (!this.token || this.sendingGroups) return;
    this.sendingGroups = true;
    try {
      for (const m of this.state.messages.filter(m => m.groupId && m.status === "pending")) {
        const g = this.state.groups.find(g => g.id === m.groupId);
        if (!g?.active) continue;
        for (const id of m.recipients || []) {
          if (!this.running || m.status !== "pending" || !this.state.messages.includes(m)) break;
          if (m.posted.includes(id)) continue;
          const member = g.members.find(member => member.id === id);
          if (!member) continue;
          const box = await sealMailbox(this.state.identity, member.publicKey, {
            id: m.id, body: m.body, kind: m.kind, time: m.time, from: this.state.identity.id, to: id, groupId: g.id,
          });
          await this.api("mailbox", "POST", { to: id, groupId: g.id, box });
          m.posted.push(id);
          await this.vault.save();
        }
        if (m.status === "pending" && m.recipients.every(id => m.posted.includes(id))) m.status = "sent";
        await this.vault.save();
        this.emit();
      }
    } finally { this.sendingGroups = false; }
  }
  async send(peer, body, kind = "text") {
    if (this.state.groups.some(g => g.id === peer)) return this.sendGroup(peer, body, kind);
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
    const p = this.peers.get(peer);
    if (!p || p.channel?.readyState !== "open") {
      this.postMailbox(peer, m)
        .then(() => {
          if (m.status === "pending") m.status = "sent";
          return this.vault.save();
        })
        .then(() => this.emit())
        .catch(() => {});
    }
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
  async postMailbox(peer, m) {
    const c = this.state.contacts.find((x) => x.id === peer && x.active);
    if (!c?.publicKey || !this.token) return;
    const box = await sealMailbox(this.state.identity, c.publicKey, {
      id: m.id,
      body: m.body,
      kind: m.kind,
      time: m.time,
      from: this.state.identity.id,
    });
    await this.api("mailbox", "POST", { to: peer, box });
  }
  async fetchMailbox() {
    if (!this.running || !this.token) return;
    if (this.fetchingMailbox) return this.fetchingMailbox;
    this.fetchingMailbox = this.readMailbox().finally(() => { this.fetchingMailbox = null; });
    return this.fetchingMailbox;
  }
  async readMailbox() {
    await this.syncGroups();
    const { items } = await this.api("mailbox");
    if (!Array.isArray(items) || !items.length) return;
    const ack = [];
    for (const item of items) {
      const group = item.groupId && this.state.groups.find(g => g.id === item.groupId);
      const c = item.groupId ? group?.members.find(m => m.id === item.from)
        : this.state.contacts.find(c => c.id === item.from && c.active);
      if (!c?.publicKey) continue;
      let msg;
      try { msg = await openMailbox(this.state.identity, c.publicKey, item.box); }
      catch { ack.push(item.id); continue; }
      if (!validMessage(msg) || msg.from !== item.from ||
        (item.groupId ? msg.groupId !== item.groupId || msg.to !== this.state.identity.id : !!msg.groupId)) {
        ack.push(item.id); continue;
      }
      const seen = (item.groupId ? item.groupId + ":" : "") + item.from + ":" + msg.id;
      if (!this.state.seen.includes(seen)) {
        const received = { id: msg.id, body: msg.body, kind: msg.kind, time: msg.time,
          ...(item.groupId ? { groupId: item.groupId } : {}),
          peer: item.groupId || item.from, sender: item.from, status: "received" };
        this.state.messages.push(received);
        this.state.seen.push(seen);
        try { await this.vault.save(); } catch (e) {
          this.state.messages = this.state.messages.filter(m => m !== received);
          this.state.seen = this.state.seen.filter(s => s !== seen);
          throw e;
        }
      }
      ack.push(item.id);
    }
    if (ack.length) await this.api("mailbox/ack", "POST", { ids: ack });
    this.emit();
  }
  async pushPermission() {
    if (!("Notification" in window)) return "unsupported";
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
    if (!this.vapidPublicKey) return "unavailable";
    return Notification.permission;
  }
  async subscribePush() {
    if (!this.vapidPublicKey || !("serviceWorker" in navigator) || !("PushManager" in window))
      throw Error("当前环境不支持消息通知");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw Error("未获得通知权限，请在系统设置中允许");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub)
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(this.vapidPublicKey),
      });
    await this.api("push/subscribe", "POST", { subscription: sub.toJSON() });
  }
  async unsubscribePush() {
    try {
      const reg = await navigator.serviceWorker?.ready;
      const sub = await reg?.pushManager?.getSubscription();
      await sub?.unsubscribe();
    } catch {
      // 忽略取消订阅失败。
    }
    await this.api("push/subscribe", "DELETE").catch(() => {});
  }
  async notifyHidden(peer, m) {
    if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted")
      return;
    const c = this.state.contacts.find((x) => x.id === peer);
    const body = m.kind === "image" ? "[图片]" : String(m.body || "").slice(0, 120);
    try {
      const reg = await navigator.serviceWorker?.ready;
      if (reg)
        await reg.showNotification(c?.name || "INOU", {
          body,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: "inou-" + peer,
          data: { peer },
        });
      else new Notification(c?.name || "INOU", { body });
    } catch {
      // 通知展示失败不影响消息接收。
    }
  }
  async tick() {
    if (!this.running || document.visibilityState === "hidden") return;
    if (!this.connected) {
      await this.connect();
      return;
    }
    if (Date.now() - this.lastMailbox > 15000) {
      this.lastMailbox = Date.now();
      this.fetchMailbox().catch(() => {});
    }
    await this.flushRelations();
    await this.syncGroups();
    await this.flushGroups();
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
    navigator.serviceWorker?.removeEventListener("message", this.swMessage);
    this.ws?.close();
    for (const id of [...this.peers.keys()]) this.drop(id);
    this.token = null;
    this.key = null;
  }
}
