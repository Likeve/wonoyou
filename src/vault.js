const enc = new TextEncoder(),
  dec = new TextDecoder();
export const to64 = (b) =>
  btoa(Array.from(new Uint8Array(b), (x) => String.fromCharCode(x)).join(""));
export const from64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const digest = async (value) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string" ? enc.encode(value) : value,
      ),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const random = (n) => crypto.getRandomValues(new Uint8Array(n));
async function passwordKey(password, salt) {
  const m = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    m,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(key, value) {
  const iv = random(12);
  return {
    iv: to64(iv),
    data: to64(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        enc.encode(JSON.stringify(value)),
      ),
    ),
  };
}
export async function unseal(key, box) {
  return JSON.parse(
    dec.decode(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: from64(box.iv) },
        key,
        from64(box.data),
      ),
    ),
  );
}
const dbPromise = () =>
  new Promise((resolve, reject) => {
    const r = indexedDB.open("inou-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("secure");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
async function record(value) {
  const db = await dbPromise();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
          "secure",
          value === undefined ? "readonly" : "readwrite",
        ),
        store = tx.objectStore("secure");
      const r =
        value === undefined ? store.get("vault") : store.put(value, "vault");
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("存储失败"));
    });
  } finally {
    db.close();
  }
}
export const hasVault = async () => !!(await record());
export async function deleteVault() {
  const db = await dbPromise();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("secure", "readwrite"),
        store = tx.objectStore("secure");
      store.delete("vault");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("清除失败"));
    });
  } finally {
    db.close();
  }
}
export async function createVault(name) {
  if (await hasVault()) throw Error("这台设备已有资料");
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicBytes = await crypto.subtle.exportKey("spki", pair.publicKey);
  const identity = {
    id: await digest(publicBytes),
    publicKey: to64(publicBytes),
    privateKey: to64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    name,
  };
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
  const header = {
    version: 2,
    key: to64(await crypto.subtle.exportKey("raw", key)),
  };
  const state = {
    identity,
    contacts: [],
    messages: [],
    seen: [],
    drafts: {},
    blocked: [],
    lastBackup: null,
  };
  const vault = makeVault(key, header, state);
  await vault.save();
  return vault;
}
export async function loadVault() {
  const r = await record();
  if (!r) throw Error("没有本地资料");
  if (r.version !== 2 || typeof r.key !== "string")
    throw Error("本地资料版本过旧，请重新创建身份");
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      from64(r.key),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    return makeVault(
      key,
      { version: r.version, key: r.key },
      await unseal(key, r.box),
    );
  } catch {
    throw Error("本地资料已损坏，请重新创建身份");
  }
}
function makeVault(key, header, state) {
  let queue = Promise.resolve();
  return {
    state,
    save() {
      const snapshot = structuredClone(state);
      const job = queue
        .catch(() => {})
        .then(async () =>
          record({ ...header, box: await seal(key, snapshot) }),
        );
      queue = job;
      return job;
    },
    async flush() {
      await queue;
    },
  };
}
export async function signingKey(identity) {
  return crypto.subtle.importKey(
    "pkcs8",
    from64(identity.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}
export async function sign(key, text) {
  return to64(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(text),
    ),
  );
}
export async function verify(publicKey, text, signature) {
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      from64(publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      from64(signature),
      enc.encode(text),
    );
  } catch {
    return false;
  }
}

// 用双方已有的 P-256 身份密钥做 ECDH，派生出 AES-GCM 会话密钥。
// 身份密钥是 ECDSA；ECDSA 与 ECDH 同曲线，可导出 JWK 后按 ECDH 复用，
// 这样无需迁移旧数据或额外发布第二把公钥。
async function deriveMailboxKey(privatePkcs8, peerPublicSpki) {
  const ecdsaPrivate = await crypto.subtle.importKey(
    "pkcs8",
    from64(privatePkcs8),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", ecdsaPrivate);
  delete privateJwk.key_ops;
  delete privateJwk.alg;
  const ecdhPrivate = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"],
  );
  const ecdsaPublic = await crypto.subtle.importKey(
    "spki",
    from64(peerPublicSpki),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", ecdsaPublic);
  delete publicJwk.key_ops;
  delete publicJwk.alg;
  const ecdhPublic = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: ecdhPublic },
    ecdhPrivate,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealMailbox(identity, peerPublicKey, message) {
  const key = await deriveMailboxKey(identity.privateKey, peerPublicKey);
  return seal(key, message);
}

export async function openMailbox(identity, peerPublicKey, box) {
  const key = await deriveMailboxKey(identity.privateKey, peerPublicKey);
  return unseal(key, box);
}

export async function exportArchive(state, password) {
  const salt = random(16);
  return {
    format: "inou-archive",
    version: 1,
    salt: to64(salt),
    box: await seal(await passwordKey(password, salt), {
      owner: state.identity.id,
      name: state.identity.name,
      created: Date.now(),
      contacts: state.contacts.map(({ id, name, remark }) => ({
        id,
        name,
        remark,
      })),
      messages: state.messages.map((m) => ({ ...m, status: "archived" })),
    }),
  };
}
export async function readArchive(file, password) {
  if (file.format !== "inou-archive" || file.version !== 1)
    throw Error("不支持的备份格式");
  let data;
  try {
    data = await unseal(
      await passwordKey(password, from64(file.salt)),
      file.box,
    );
  } catch {
    throw Error("备份口令不正确或文件损坏");
  }
  if (
    !Array.isArray(data.messages) ||
    !Array.isArray(data.contacts) ||
    !/^[a-f0-9]{64}$/.test(data.owner) ||
    data.messages.length > 100000
  )
    throw Error("备份内容无效");
  for (const c of data.contacts) {
    if (!c || !/^[a-f0-9]{64}$/.test(c.id)) throw Error("备份中的联系人无效");
  }
  for (const m of data.messages) {
    if (
      !validMessage(m) ||
      !/^[a-f0-9]{64}$/.test(m.peer) ||
      !/^[a-f0-9]{64}$/.test(m.sender)
    )
      throw Error("备份中的消息无效");
  }
  return data;
}
export function validMessage(m) {
  return (
    m &&
    typeof m.id === "string" &&
    m.id.length < 100 &&
    Number.isFinite(m.time) &&
    ((m.kind === "text" &&
      typeof m.body === "string" &&
      [...m.body].length <= 4000) ||
      (m.kind === "image" &&
        typeof m.body === "string" &&
        /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(m.body) &&
        m.body.length <= 2800000))
  );
}
export async function prepareImage(file) {
  if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024)
    throw Error("请选择 10 MB 以内的图片");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 2048 / Math.max(img.width, img.height)),
      canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    let data;
    for (const q of [0.82, 0.65, 0.45]) {
      data = canvas.toDataURL("image/jpeg", q);
      if (data.length <= 2800000) return data;
    }
    throw Error("压缩后的图片仍太大，请选择小一些的图片");
  } finally {
    URL.revokeObjectURL(url);
  }
}
