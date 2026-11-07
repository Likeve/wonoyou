async () => {
  const browser = page.context().browser();
  const aContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const bContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const a = await aContext.newPage(),
    b = await bContext.newPage();
  const issues = [];
  for (const p of [a, b]) p.on("pageerror", (e) => issues.push(e.message));
  const create = async (p, name) => {
    await p.goto("http://localhost:8787");
    await p.getByLabel("你的昵称").fill(name);
    await p.getByRole("button", { name: "创建本地身份" }).click();
    await p.getByText("已连接 · 记录仅存本机").waitFor({ timeout: 15000 });
  };
  await create(a, "小林");
  await create(b, "阿青");
  await b.getByRole("button", { name: "我", exact: true }).click();
  await b.getByRole("button", { name: "我的身份码", exact: true }).click();
  await b.locator(".id-code").waitFor();
  const code = await b.locator(".id-code").innerText();
  await b.getByRole("button", { name: "关闭", exact: true }).click();
  await a
    .getByRole("button", { name: "添加好友", exact: true })
    .first()
    .click();
  await a.getByLabel("对方身份码").fill(code);
  await a.getByRole("dialog").getByRole("button", { name: "查找对方", exact: true }).click();
  await a.locator(".preview-card").waitFor();
  await a.locator(".preview-name").filter({ hasText: "阿青" }).waitFor();
  await a.getByRole("button", { name: "确定添加", exact: true }).click();
  await a.getByLabel("消息", { exact: true }).waitFor();
  await b.getByRole("button", { name: "聊天", exact: true }).click();
  await b.locator(".contact-row").first().click();
  await a
    .getByText("已连接，可以聊天", { exact: true })
    .waitFor({ timeout: 30000 });
  await b
    .getByText("已连接，可以聊天", { exact: true })
    .waitFor({ timeout: 30000 });
  await a
    .getByLabel("消息", { exact: true })
    .fill("你好，阿青！这条消息只保存在我们的设备。");
  await a.getByRole("button", { name: "发送", exact: true }).click();
  await b
    .locator(".bubble")
    .filter({ hasText: "你好，阿青！" })
    .waitFor({ timeout: 15000 });
  await a.getByText("已送达", { exact: true }).waitFor({ timeout: 15000 });
  await b
    .getByLabel("消息", { exact: true })
    .fill("收到啦 🌿 这样的聊天刚刚好。");
  await b.getByRole("button", { name: "发送", exact: true }).click();
  await a
    .locator(".bubble")
    .filter({ hasText: "收到啦" })
    .waitFor({ timeout: 15000 });
  await a.screenshot({ path: "output/playwright/desktop-chat.png" });
  await b.screenshot({ path: "output/playwright/mobile-chat.png" });
  await b.close();
  await a.waitForTimeout(1200);
  await a
    .getByLabel("消息", { exact: true })
    .fill("离线待发测试：重新上线后仅送达一次。");
  await a.getByRole("button", { name: "发送", exact: true }).click();
  await a.getByText("等待双方上线", { exact: true }).last().waitFor();
  const b2 = await bContext.newPage();
  await b2.goto("http://localhost:8787");
  await b2.getByText("已连接 · 记录仅存本机").waitFor({ timeout: 15000 });
  await b2.locator(".contact-row").first().click();
  await b2
    .locator(".bubble")
    .filter({ hasText: "离线待发测试" })
    .waitFor({ timeout: 30000 });
  await a.waitForTimeout(6000);
  if (
    (await b2
      .locator(".bubble")
      .filter({ hasText: "离线待发测试" })
      .count()) !== 1
  )
    throw Error("duplicate delivery");
  await a
    .locator('input[type=file][accept="image/*"]')
    .setInputFiles("/Users/kevin/Documents/ChatGPT/INOU/public/icon-512.png");
  await b2.locator(".image-bubble img").waitFor({ timeout: 15000 });
  await a
    .locator(".message-status")
    .filter({ hasText: "已送达" })
    .last()
    .waitFor();
  await a.getByRole("button", { name: "我", exact: true }).click();
  await a.getByRole("button", { name: "数据与备份" }).click();
  await a.getByLabel("备份口令", { exact: true }).fill("INOU-backup-test");
  await a.getByLabel("确认备份口令", { exact: true }).fill("INOU-backup-test");
  const downloadPromise = a.waitForEvent("download");
  await a.getByRole("button", { name: "导出加密备份" }).click();
  const download = await downloadPromise;
  await download.saveAs(
    "/Users/kevin/Documents/ChatGPT/INOU/output/playwright/test-backup.inou",
  );
  await a
    .locator('input[type=file][accept=".inou,application/json"]')
    .setInputFiles(
      "/Users/kevin/Documents/ChatGPT/INOU/output/playwright/test-backup.inou",
    );
  await a.getByLabel("该备份的口令").fill("wrong");
  await a.getByRole("button", { name: "导入历史记录", exact: true }).click();
  await a.getByRole("alert").filter({ hasText: "口令不正确" }).waitFor();
  await a.getByLabel("该备份的口令").fill("INOU-backup-test");
  await a.getByRole("button", { name: "导入历史记录", exact: true }).click();
  await a
    .getByRole("status")
    .filter({ hasText: "已导入 0 条历史记录" })
    .waitFor();
  await a.getByRole("button", { name: "关闭", exact: true }).click();
  await a.getByRole("button", { name: "聊天", exact: true }).click();
  const raw = await a.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("inou-v1");
        r.onsuccess = () => {
          const q = r.result
            .transaction("secure")
            .objectStore("secure")
            .get("vault");
          q.onsuccess = () => {
            resolve(JSON.stringify(q.result));
            r.result.close();
          };
        };
        r.onerror = () => reject(r.error);
      }),
  );
  if (
    raw.includes("阿青") ||
    raw.includes("你好") ||
    raw.includes("privateKey")
  )
    throw Error("plaintext in storage");
  await a.reload();
  await a.getByText("已连接 · 记录仅存本机").waitFor({ timeout: 15000 });
  await a.locator(".contact-row").first().click();
  await a.locator(".bubble").filter({ hasText: "你好，阿青！" }).waitFor();
  const result = {
    passed: [
      "two identities",
      "identity code add",
      "authenticated WebRTC",
      "bidirectional delivery + ACK",
      "offline queue + reconnect",
      "no duplicate delivery",
      "encrypted IndexedDB",
      "history survives reload",
      "image transfer",
      "encrypted backup export",
      "wrong backup password rejected",
      "archive import deduplication",
    ],
    issues,
  };
  await a.evaluate(() => navigator.serviceWorker.ready);
  await a.reload();
  await aContext.setOffline(true);
  await a.reload();
  await a.locator(".contact-row").first().waitFor({ timeout: 15000 });
  await a.locator(".contact-row").first().click();
  await a.locator(".bubble").filter({ hasText: "你好，阿青！" }).waitFor();
  result.passed.push("offline app shell + local history");
  await a.getByRole("button", {name: "聊天详情"}).click();
  await a.getByRole("button", {name: "加入黑名单", exact: true}).click();
  await a.getByRole("button", {name: "确认拉黑", exact: true}).click();
  await a.getByRole("status").filter({hasText: "已在本机生效，联网后同步"}).waitFor();
  if (!await a.getByLabel("消息", {exact:true}).isDisabled()) throw Error("blocked conversation still writable");
  await aContext.setOffline(false);
  await b2.getByText("关系已结束", {exact:true}).waitFor({timeout:20000});
  result.passed.push("offline block + online relationship sync");
  if (issues.length) throw Error(issues.join(";"));
  await aContext.close();
  await bContext.close();
  return result;
}
