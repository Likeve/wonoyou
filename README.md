# INOU

微信式的一对一聊天 PWA 开发版。通过本地唯一身份码建立好友关系，聊天内容和图片只保存在双方设备。离线消息留在发送端，双方重新打开应用后再投递。

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
- 本地身份、口令解锁、AES-GCM 加密 IndexedDB、后台 60 秒自动锁定、多窗口互斥。
- 本地唯一身份码（设备公钥的 SHA-256）直接添加好友，幂等添加、双向好友关系。
- WebRTC DataChannel 一对一文字与图片；签名信令绑定设备公钥和 SDP；标准 WebRTC DTLS 加密传输。
- 消息先本地落库、接收端落库后 ACK、重连重试、消息去重、待发取消。
- 本地备注、历史记录、草稿、聊天清空、删除好友与拉黑。
- 加密历史备份导出、密码校验、导入去重；备份不包含身份私钥或可执行待发任务。
- 手机和桌面界面、图片预览、表情、联系人筛选、应用更新提示。

## 数据如何流动

```text
设备 A 加密 IndexedDB ←→ WebRTC DTLS DataChannel ←→ 设备 B 加密 IndexedDB
       │                          │                         │
       └────────── 身份与信令服务 ─┴─────────────────────────┘
                  仅身份公钥 / 好友与封禁关系
                  TURN 配置后可以实时中继加密网络数据
```

本地服务器 SQLite 只有 devices、relations、blocks 三张业务表。Vercel 后端改用 Redis 共享关系元数据与有过期时间的认证/在线状态，信令通过 Pub/Sub 实时转发，不落库。服务不提供消息保存、附件上传或历史查询接口。WebSocket 只转发好友间的信令，不接受聊天消息帧。私钥、昵称、正文、图片和备份口令不上传 API。

不要在反向代理、错误上报、APM 或 TURN 中开启请求正文、载荷或全量会话日志。部署者仍能观察连接时间、IP 和流量大小。

## 手机安装与跨网络使用

当前仍是 0.1 开发版，已完成 Vercel 云端适配与 Redis 接入，**尚未完成 iPhone 真机验收**。部署资源、环境变量和更新方式见 [Vercel 部署说明](docs/Vercel部署说明.md)。手机上的 localhost 指手机自身，不能用本机预览链接直接访问电脑。

1. 将前端与 Node 服务以同一个 HTTPS 域名提供，反向代理需支持 `/signal` WebSocket Upgrade。
2. 复制 `.env.example` 为 `.env`，填写 `APP_ORIGIN` 为完整 HTTPS origin。
3. 配置自己的 STUN 和 TURN。未配置时仍可在允许直接连接的环境测试，但跨蜂窝网络无法保证连通。TURN_SECRET 只放服务器，不进入前端构建。
4. iPhone 用 Safari 打开 HTTPS 地址，添加到主屏幕后再创建身份。普通局域网 HTTP 不满足 Web Crypto / Service Worker 安全上下文要求。
5. 用两台真实 iPhone 验证锁屏、后台、切网、移动键盘、图片选择、文件导入导出和强制 TURN 后再内测。

自托管时可参考 `deploy/Caddyfile.example`；Vercel 通过 `vercel.json` 配置静态页面、API 和 WebSocket 路由。

## 当前阶段与 PRD 的差异

这是 0.1 技术原型，不是已审计的生产即时通信服务。

- 传输使用浏览器标准 DTLS，加上身份签名的 SDP 信令。**尚未实现 PRD 中独立的应用层 Double Ratchet / 每消息棘轮加密**，也未经过独立密码评审；不宣称达到 Signal 的安全级别。
- 本地存储目前是整库加密快照，适合验证流程；大量历史与附件需迁移到分记录加密事务库。PRD 的 10,000 条性能目标尚未验收。
- 通知推送、多设备、语音、搜索聊天内容和身份迁移不在此版。关闭应用后不承诺持续收发。
- 真实 TURN 中继、Safari 与 iOS 生命周期尚待配置和真机验证；桌面 Chromium 的移动尺寸测试不能替代 iPhone 验收。
- 手动删除网站数据或丢失口令后不能云端恢复。备份仅恢复历史，新的安装实例需重新加好友。
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
