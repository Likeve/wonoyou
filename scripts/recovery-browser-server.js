// Isolated UI fixture: no real credentials, no real account writes.
// Build with VITE_SUPABASE_URL=https://auth.example.test and
// VITE_SUPABASE_ANON_KEY=isolated-test-key into output/recovery-ui first.
import express from "express";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRecoveryHandler } from "../server/recovery.js";
const hash = value => createHash("sha256").update(value).digest("hex");
const username = "旧测试账号", phrase = "山 海 星 月 春 风 秋 雨";
const user = { id: "isolated-user", email: hash("inou-username:" + username).slice(0, 48) + "@inou.app",
  user_metadata: { username, recovery: hash("recovery:" + username + ":" + phrase) } };
const app = express();
app.use(express.json());
app.post("/api/recover", createRecoveryHandler({
  limited: async () => false,
  config: () => ({ url: "https://auth.example.test", key: "test-only" }),
  fetchAuth: async (_, options) => Response.json(options.method === "PUT" ? user : { users: [user] }),
}));
app.use(express.static(resolve("output/recovery-ui")));
app.listen(8792, "127.0.0.1", () => console.log("Isolated recovery UI at http://127.0.0.1:8792"));
