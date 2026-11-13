import { createClient } from "@supabase/supabase-js";
import { digest } from "./vault";
import { recoveryHash } from "./recovery.js";
export { generateRecoveryPhrase } from "./recovery.js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;

export const hasSupabase = () => !!supabase;

export async function requestRecovery(phrase, password) {
  const r = await fetch("/api/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phrase: String(phrase || "").trim().replace(/\s+/g, " "),
      password: String(password || ""),
    }),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "重置失败");
  return d;
}

// Supabase 只有邮箱密码登录；这里把「用户名」映射成一个内部合成邮箱，
// 用户名本身保存到 user_metadata，界面与邮箱完全无关。
async function emailFor(username) {
  const h = await digest("inou-username:" + String(username || "").trim());
  return h.slice(0, 48) + "@inou.app";
}

export async function currentSession() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signIn(username, password) {
  if (!supabase) throw Error("未配置 Supabase");
  const email = await emailFor(username);
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password: String(password || ""),
  });
  if (error) throw error;
  return data;
}

export async function signUp(username, password, phrase) {
  if (!supabase) throw Error("未配置 Supabase");
  const email = await emailFor(username);
  const { data, error } = await supabase.auth.signUp({
    email,
    password: String(password || ""),
    options: { data: { username: String(username || "").trim(), recovery: await recoveryHash(username, phrase) } },
  });
  if (error) throw error;
  return data;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export function readableAuthError(error) {
  const msg = String(error?.message || error || "");
  if (/Invalid login credentials/i.test(msg)) return "用户名或密码不正确";
  if (/already registered/i.test(msg)) return "该用户名已被占用，请换一个";
  if (/Password should be at least/i.test(msg)) return "密码至少需要 6 位";
  if (/rate limit/i.test(msg)) return "尝试次数过多，请稍后再试";
  if (/Failed to fetch|fetch failed|NetworkError/i.test(msg))
    return "无法连接账号服务，请检查网络后重试";
  return msg || "操作没有完成，请重试";
}
