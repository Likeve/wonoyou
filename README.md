# INOU

支持一对一和群聊的 PWA 开发版。通过本地唯一身份码添加好友或邀请群成员；聊天正文和图片在设备上解密，服务器可暂存待收取的密文。

## 本地运行

需要 Node.js 22.13 或以上。

```sh
npm ci
npm run build
npm start
```

打开 http://localhost:8787 。也可双击项目根目录的 `启动INOU.command`。

开发时执行 `npm run dev`，打开 http://localhost:5173 。5173 和 8787 是不同的浏览器存储空间；请勿混用同一身份。测试两个身份，请使用两个独立浏览器配置或隐私上下文，而非同一个浏览器的两个标签页。

## 已实现

- iOS 主屏幕安装所需 Manifest、192/512 图标、Apple Touch Icon、Service Worker 与离线应用缓存。
- 本地身份、AES-GCM 加密 IndexedDB、多窗口互斥；无需解锁，打开即用。
- 本地唯一身份码（设备公钥的 SHA-256）直接添加好友；添加前先按身份码预览对方昵称、确认后建立关系，幂等添加、双向好友关系。
- 可选 Supabase 邮箱登录/注册/登出（账号层）；聊天记录仍只存本机，并按账号 ID 隔离存储——登出不清空，同一账号重新登录可继续看到记录，换账号互相看不到。
- WebRTC DataChannel 一对一文字与图片；签名信令绑定设备公钥和 SDP；标准 WebRTC DTLS 加密传输。
- 消息先本地落库、接收端落库后 ACK、重连重试、消息去重、待发取消。
- 消息通知：对方不在线时，消息用双方身份密钥派生出的会话密钥加密后暂存服务器（密文），并通过 Web Push 提醒对方；对方回到应用后取回解密。iPhone 需先安装到主屏幕。
- 本地备注、历史记录、草稿、聊天清空、删除好友与拉黑。
- 加密历史备份导出、密码校验、导入去重；备份不包含身份私钥或可执行待发任务。
- 手机和桌面界面、图片预览、表情、联系人筛选、应用更新提示。

## 群聊和检查更新（0.2.0）

- 在聊天或通讯录页面点击“创建群聊”，填写群名称和至少一位其他用户的身份码。支持复制的 `INOU-…` 格式；多位成员每行一个，或用逗号分隔，当前最多 20 人。
- 创建后，对方无需确认，在线时自动显示新群，离线时下次打开同步。群详情中任何成员都可以通过身份码继续邀请；不会因此自动互加好友。
- 群消息按收件人分别加密后通过信箱投递；“已投递”表示服务器已接受所有收件人的密文，不代表所有成员已读。新增成员不补发入群前历史。群名称、成员身份和公钥属于服务器可见元数据。
- 沿用现有 ECDH + AES-GCM 加密机制，本次没有实现 Double Ratchet。退群、移除成员和群管理员权限不在本次功能范围。
- “我”页面最底部的“检查更新”会请求不缓存的 `version.json`。发现不同构建时先保存本机数据、等待 Service Worker 下载和激活，再刷新页面；不会清除身份或聊天记录。
- 构建时自动生成唯一标识，因此即使版本号相同也能识别新的部署。必须一起部署前端、Service Worker、版本清单和后端，线上旧版本不会凭本地构建自动更新。
- 群聊历史支持加密备份；导入备份不会恢复群成员权限或重新发送历史消息。

## 找回账号

登录页选择“找回账号 / 重置密码”，只需输入注册时保存的 8 个找回词、新密码和确认新密码，无需填写用户名。重置成功后会自动填入对应账号，使用新密码登录即可。已成功保存到账号资料中的旧找回密钥继续有效。

新账号在创建时同时保存密钥摘要，避免注册成功但找回密钥未保存。服务器仅在完整检索后唯一匹配到账号时才重置密码；错误、重复匹配或身份服务故障不会修改账号。当前兼容实现最多扫描 20 页、每页 200 个账号；达到上限但检索未结束时返回暂不可用，不会只凭部分结果重置。

服务端需要 `SUPABASE_SERVICE_ROLE_KEY`，地址优先使用 `SUPABASE_URL`，未配置时复用 `VITE_SUPABASE_URL`。管理密钥不可添加 `VITE_` 前缀。配置需覆盖所用的 Production / Preview 环境，代码与变量更新后需要重新部署。

验证：`node --test test/recovery.test.js`。隔离浏览器测试使用 `scripts/recovery-browser-server.js` 与 `scripts/recovery-browser-smoke.js`，不访问真实 Supabase 账号。

## 数据如何流动

```text
设备 A 加密 IndexedDB ←→ WebRTC DTLS DataChannel ←→ 设备 B 加密 IndexedDB
       │                          │                         │
       └────────── 身份与信令服务 ─┴─────────────────────────┘
                  仅身份公钥 / 昵称 / 好友与封禁关系
                  TURN 配置后可以实时中继加密网络数据
```

本地服务器 SQLite 保存 devices、relations、blocks、mailbox、pushes，以及 groups_meta、group_members 两张群元数据表；mailbox 只存端到端加密的消息密文，pushes 只存推送订阅端点。Vercel 后端改用 Redis 共享关系元数据与有过期时间的认证/在线状态，信令通过 Pub/Sub 实时转发，不落库。服务不提供消息明文保存、附件上传或历史查询接口。WebSocket 只转发好友间的信令，不接受聊天消息帧。昵称仅用于加好友前的身份确认；私钥、消息正文和图片的明文、备份口令不上传 API。

离线信箱中的消息也是端到端加密：服务器只保存 AES-GCM 密文（iv + data），解密密钥由双方设备密钥经 ECDH 派生，服务器无法解出正文。推送通知只包含「有新消息」的提醒，不含内容。

不要在反向代理、错误上报、APM 或 TURN 中开启请求正文、载荷或全量会话日志。部署者仍能观察连接时间、IP 和流量大小。

## 手机安装与跨网络使用

当前仍是 0.2 开发版，已完成 Vercel 云端适配与 Redis 接入，**尚未完成 iPhone 真机验收**。部署资源、环境变量和更新方式见 [Vercel 部署说明](docs/Vercel部署说明.md)。手机上的 localhost 指手机自身，不能用本机预览链接直接访问电脑。

1. 将前端与 Node 服务以同一个 HTTPS 域名提供，反向代理需支持 `/signal` WebSocket Upgrade。
2. 复制 `.env.example` 为 `.env`，填写 `APP_ORIGIN` 为完整 HTTPS origin。
3. 配置自己的 STUN 和 TURN。未配置时仍可在允许直接连接的环境测试，但跨蜂窝网络无法保证连通。TURN_SECRET 只放服务器，不进入前端构建。
4. iPhone 用 Safari 打开 HTTPS 地址，添加到主屏幕后再创建身份。普通局域网 HTTP 不满足 Web Crypto / Service Worker 安全上下文要求。
5. 用两台真实 iPhone 验证锁屏、后台、切网、移动键盘、图片选择、文件导入导出和强制 TURN 后再内测。

自托管时可参考 `deploy/Caddyfile.example`；Vercel 通过 `vercel.json` 配置静态页面、API 和 WebSocket 路由。

## 当前阶段与 PRD 的差异

这是 0.2 技术原型，不是已审计的生产即时通信服务。

- 传输使用浏览器标准 DTLS，加上身份签名的 SDP 信令。**尚未实现 PRD 中独立的应用层 Double Ratchet / 每消息棘轮加密**，也未经过独立密码评审；不宣称达到 Signal 的安全级别。
- 本地存储目前是整库加密快照，适合验证流程；大量历史与附件需迁移到分记录加密事务库。PRD 的 10,000 条性能目标尚未验收。
- 通知推送、多设备、语音、搜索聊天内容和身份迁移不在此版。关闭应用后不承诺持续收发。
- 真实 TURN 中继、Safari 与 iOS 生命周期尚待配置和真机验证；桌面 Chromium 的移动尺寸测试不能替代 iPhone 验收。
- 手动删除网站数据后不能云端恢复。备份仅恢复历史，新的安装实例需重新加好友。
- 本地清空保留去重标识，防止重发导致已删除消息再次出现；旧备份不被远程擦除。

## 验证

```sh
npm test
npm run build
npm audit
```

服务测试涵盖认证拒绝、挑战重放、身份码幂等添加、拉黑、信令权限和无消息 API。浏览器回归脚本是 `scripts/browser-smoke.js`，用 Playwright CLI 的 `run-code` 运行；其中昵称与口令均为隔离测试数据，不是用户凭据。运行前启动 8787 端口，测试截图和备份输出在忽略版本控制的 `output/playwright`。

依赖锁定在 package-lock.json。overrides 用于避开构建工具链已报告的 glob/minimatch/deepmerge 问题；升级依赖后应重新检查构建与审计。

## 目录

- `src/main.jsx`：页面、好友操作、聊天、备份和安装引导。
- `src/engine.js`：身份认证、签名信令、WebRTC、消息分块、回执与重试。
- `src/vault.js`：本地密钥、AES-GCM、IndexedDB、备份格式与图片处理。
- `server/app.js`：元数据数据库、身份验证、身份码好友关系和信令服务。
- `docs/INOU_技术可行性与PRD.md`：产品边界和验收要求。

官方参考：[WebRTC DataChannel 加密](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)、[iOS 主屏幕 Web App](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)、[WebKit 存储策略](https://webkit.org/blog/14403/updates-to-storage-policy/)。

群聊回归：`node --test test/groups.test.js`。使用隔离 Redis 时设置 `TEST_REDIS_URL`，再执行 `INOU_TEST_GROUP_BACKEND=redis node --test test/groups.test.js`；完整 `npm test` 也会执行双实例群列表同步测试。`scripts/group-browser-smoke.js` 用 Playwright CLI `run-code` 验证三个独立浏览器身份，默认测试服务为 `127.0.0.1:8791`。
