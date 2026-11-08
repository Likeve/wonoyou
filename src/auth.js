import { createClient } from "@supabase/supabase-js";
import { digest } from "./vault";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;

export const hasSupabase = () => !!supabase;

// 找回密钥：8 个随机 1–2 字中文组合，无实际含义，类似助记词。
const PHRASE_POOL =
  "的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感";

export function generateRecoveryPhrase() {
  const words = [];
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 8; i++) {
    const len = bytes[i] % 2 === 0 ? 2 : 1;
    let word = "";
    for (let j = 0; j < len; j++) {
      word += PHRASE_POOL[bytes[i * 2 + j] % PHRASE_POOL.length];
    }
    if (!words.includes(word)) words.push(word);
    else i--;
  }
  return words;
}

export async function recoveryHash(username, phrase) {
  const normalized = String(phrase || "")
    .trim()
    .replace(/\s+/g, " ");
  return digest("recovery:" + String(username || "").trim() + ":" + normalized);
}

export async function storeRecovery(username, phrase) {
  if (!supabase) return;
  const { error } = await supabase.auth.updateUser({
    data: { recovery: await recoveryHash(username, phrase) },
  });
  if (error) throw error;
}

export async function requestRecovery(username, phrase, password) {
  const r = await fetch("/api/recover", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: String(username || "").trim(),
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

export async function signUp(username, password) {
  if (!supabase) throw Error("未配置 Supabase");
  const email = await emailFor(username);
  const { data, error } = await supabase.auth.signUp({
    email,
    password: String(password || ""),
    options: { data: { username: String(username || "").trim() } },
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
  return msg || "操作没有完成，请重试";
}
