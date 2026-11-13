import { createHash, timingSafeEqual } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const failure = (res, status, error) => res.status(status).json({ error });

export function createRecoveryHandler({
  limited,
  fetchAuth = fetch,
  config = () => ({
    url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  }),
} = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const { url, key } = config();
    if (!url || !key) return failure(res, 503, "找回功能未配置");
    const ip = process.env.VERCEL
      ? req.headers["x-vercel-forwarded-for"] || req.socket.remoteAddress
      : req.socket.remoteAddress;
    if (await limited("recover:" + ip, 20)) return failure(res, 429, "尝试过多，请稍后再试");
    const phrase = typeof req.body?.phrase === "string" ? req.body.phrase.trim().replace(/\s+/g, " ") : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!phrase || phrase.length > 256 || phrase.split(" ").length !== 8)
      return failure(res, 400, "请输入完整的 8 个找回词，用空格隔开");
    if (password.length < 6 || password.length > 200) return failure(res, 400, "新密码需为 6–200 位");
    const base = url.replace(/\/$/, "");
    const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
    let match = null, complete = false;
    try {
      // Existing hashes include the username. Read it from the account, never from
      // the recovery request, so already-issued eight-word keys remain valid.
      // Finish the scan before writing: an ambiguous key must not reset any user.
      for (let page = 1; page <= 20; page++) {
        const response = await fetchAuth(`${base}/auth/v1/admin/users?page=${page}&per_page=200`, {
          headers, signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return failure(res, 502, "身份服务暂不可用，请稍后重试");
        const data = await response.json();
        if (!Array.isArray(data.users)) return failure(res, 502, "身份服务暂不可用，请稍后重试");
        for (const user of data.users) {
          const username = user.user_metadata?.username;
          const stored = user.user_metadata?.recovery;
          if (typeof username !== "string" || !username.trim() || typeof stored !== "string" || !/^[a-f0-9]{64}$/.test(stored)) continue;
          const name = username.trim();
          if (user.email !== hash("inou-username:" + name).slice(0, 48) + "@inou.app") continue;
          const expected = hash("recovery:" + name + ":" + phrase);
          if (!timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(expected, "hex"))) continue;
          if (match && match.id !== user.id) return failure(res, 409, "找回密钥无法唯一识别账号，暂时无法重置");
          match = { id: user.id, username: name };
        }
        if (data.users.length < 200) { complete = true; break; }
      }
      if (!complete) return failure(res, 503, "账号检索暂未完成，请稍后重试");
      if (!match) return failure(res, 400, "找回密钥不正确或已失效");
      const response = await fetchAuth(`${base}/auth/v1/admin/users/${encodeURIComponent(match.id)}`, {
        method: "PUT", headers, body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return failure(res, 502, "密码重置失败，请稍后再试");
      res.json({ ok: true, username: match.username });
    } catch {
      return failure(res, 502, "身份服务暂不可用，请稍后重试");
    }
  };
}
