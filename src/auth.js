import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey ? createClient(url, anonKey) : null;

export const hasSupabase = () => !!supabase;

export async function currentSession() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function signIn(email, password) {
  if (!supabase) throw Error("未配置 Supabase");
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || "").trim(),
    password: String(password || ""),
  });
  if (error) throw error;
  return data;
}

export async function signUp(email, password) {
  if (!supabase) throw Error("未配置 Supabase");
  const { data, error } = await supabase.auth.signUp({
    email: String(email || "").trim(),
    password: String(password || ""),
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
  if (/Invalid login credentials/i.test(msg)) return "邮箱或密码不正确";
  if (/already registered/i.test(msg)) return "该邮箱已注册，请直接登录";
  if (/Password should be at least/i.test(msg)) return "密码至少需要 6 位";
  if (/email address/i.test(msg) && /invalid/i.test(msg)) return "邮箱格式不正确";
  if (/rate limit/i.test(msg)) return "尝试次数过多，请稍后再试";
  return msg || "操作没有完成，请重试";
}
