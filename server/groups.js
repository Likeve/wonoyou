import { randomUUID } from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });
const identity = (value) => {
  const id = typeof value === "string" ? value.replace(/^INOU[-:\s]*/i, "").replace(/[\s-]/g, "").toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(id)) throw fail(400, "身份码格式不正确");
  return id;
};
// Group names and membership are server metadata; message bodies remain encrypted.
export function installGroups(app, store, notify) {
  const describe = async (g) => ({ ...g, members: await Promise.all(g.members.map(async id => ({ id, ...await store.device(id) }))) });
  const validate = async (actor, ids, existing = []) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 19) throw fail(400, "请至少输入一位其他用户的身份码（群聊最多 20 人）");
    const added = [...new Set(ids.map(identity))];
    if (added.includes(actor)) throw fail(400, "请输入其他用户的身份码");
    const members = [...new Set([...existing, actor, ...added])];
    if (members.length > 20) throw fail(400, "群聊最多 20 人");
    for (const id of added) {
      if (!await store.device(id)) throw fail(400, "找不到该身份码，请确认对方已上线");
      for (const member of members) {
        if (member !== id && await store.blockedPair(member, id)) throw fail(403, "成员间存在黑名单关系，无法邀请");
      }
    }
    return members;
  };
  app.get("/api/groups", async (req, res) => {
    res.json({ groups: await Promise.all((await store.groups(req.deviceId)).map(describe)) });
  });
  app.post("/api/groups", async (req, res) => {
    if (await store.limited("groups:" + req.deviceId, 10)) throw fail(429, "创建或邀请太频繁，请稍后再试");
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 32) throw fail(400, "请输入 1–32 字的群名称");
    const members = await validate(req.deviceId, req.body?.members);
    const group = { id: "group-" + randomUUID(), name, owner: req.deviceId, members, created: Date.now(), revision: 1 };
    await store.saveGroup(group, 0);
    res.json({ group: await describe(group) });
    await notify(members);
  });
  app.post("/api/groups/:id/members", async (req, res) => {
    if (await store.limited("groups:" + req.deviceId, 10)) throw fail(429, "创建或邀请太频繁，请稍后再试");
    const group = await store.group(req.params.id);
    if (!group?.members.includes(req.deviceId)) throw fail(403, "只有群成员可以邀请");
    const members = await validate(req.deviceId, req.body?.members, group.members);
    const next = { ...group, members, revision: group.revision + 1 };
    await store.saveGroup(next, group.revision);
    res.json({ group: await describe(next) });
    await notify(members);
  });
}
