# INOU Vercel 部署

更新时间：2026-11-07。

预览部署已由 Vercel 报告为 **READY**：

- [打开 INOU 预览](https://inou-id9dcay69-kvs-projects-27dae651.vercel.app)
- [部署控制台](https://vercel.com/kvs-projects-27dae651/inou/814FQngf79WXShndHe9f6zAeYHUY)

保留 Vercel Authentication 访问保护；链接需要有权限的 Vercel 账号登录。未对已部署网址执行 HTTP 或浏览器功能验收，以下测试均为本地程序连接真实 Redis 的结果。

首次被平台自动分配到 Production 的部署已经撤回；交付的是上述 Preview 部署。浏览器回归使用的独立 Redis 测试键已清理，原有本地 8787 应用数据未迁移。

## 资源与边界

- Vercel 项目：`kvs-projects-27dae651/inou`。
- 数据服务：Upstash Redis，`upstash-kv-coral-feather`，当前为 Free 方案。
- 静态前端：Vite + React + PWA；`api/backend.js` 导出 Node HTTP Server，承接 `/api/*` 和 `/signal`。
- 本地默认服务仍使用 SQLite；Vercel 服务使用 Redis，不读写本机 `.data`。
- Redis 保存设备公钥、邀请码校验值、好友/封禁关系，以及有过期时间的认证、限流和在线状态。聊天正文、图片、昵称、身份私钥和备份口令不进入这些数据结构。
- 信令通过 Redis Pub/Sub 实时转发；不使用消息队列、Streams 或历史消息存储。离线消息仍保留在发送设备，双方重新在线后传送。

## 环境变量

| 变量 | 配置位置与用途 |
| --- | --- |
| `REDIS_URL` | Redis 集成自动注入，只在服务端使用，连接使用 TLS。也支持 `KV_URL`。 |
| `REDIS_NAMESPACE` | Preview 为 `inou-preview-v1`，Production 为 `inou-production-v1`，分开关系与身份元数据。 |
| `APP_ORIGIN` | 使用固定域名或别名时填写准确的 HTTPS origin，不带末尾 `/`。部署自身的 `VERCEL_URL` 自动允许。 |
| `STUN_URL` | 自有 STUN 地址，可逗号分隔；当前未配置。 |
| `TURN_URL` | 自有 TURN/TURNS 地址，可逗号分隔；当前未配置。 |
| `TURN_SECRET` | 仅服务端持有，生成有效期一小时的 TURN 临时凭据；当前未配置。 |

不要给这些变量加 `VITE_` 前缀，也不要将数据库连接字符串放进前端。预览环境的 Secret 不可通过 `vercel env pull` 导出。需要本地测试时，可使用数据库控制台提供的配置，保存到被 Git 忽略的 `.env.cloud-test.local`，文件权限设为 `600`。

## 部署与更新

```sh
npm ci
npm test
npm run build
npm audit
npx vercel link --yes --project inou --scope kvs-projects-27dae651
npx vercel deploy --yes --environment=preview
```

**新项目第一次不指定环境的部署可能被自动分配到 Production。预览必须明确写 `--environment=preview`。** 旧版 CLI 可用 `--target=preview`。生产发布需另行选择正式域名、设置 Production 的 `APP_ORIGIN`，并使用 `--prod`。

`.vercelignore` 排除数据库、环境文件、测试备份、截图和文档。不要将整个工作目录不加筛选地打包上传。

Vercel 函数的最长运行时间配置为 300 秒；达到上限时 WebSocket 会断开。客户端每 5 秒尝试恢复连接、重新认证与同步好友状态。通信确认前的消息保留在本地待发，不依赖某一个函数实例的存活。Redis 在线状态有 75 秒过期时间，异常退出后自动失效。

保留 Vercel 默认部署访问保护；预览链接可能要求 Vercel 登录。未关闭鉴权或更改公开访问权限。使用最终确定的同一个域名安装 PWA：不同域名拥有独立的本地身份和历史，测试身份不会自动迁移。

## 本地验证云端后端

`.env.cloud-test.local` 由数据库控制台取得，不能提交到 Git。以下命令不会打印密钥：

```sh
node --env-file=.env.cloud-test.local --input-type=module -e 'import { spawn } from "node:child_process"; const child=spawn(process.execPath,["--test","test/cloud.test.js"],{stdio:"inherit",env:{...process.env,TEST_REDIS_URL:process.env.REDIS_URL||process.env.KV_URL}}); child.on("exit",code=>process.exit(code??1));'
```

集成测试启动两个独立的 Node 服务实例，使用随机测试命名空间。覆盖跨实例挑战认证、挑战不可重放、邀请码并发核销与幂等、撤销/过期/封禁、信令权限、函数重启恢复，以及没有消息接口或信令落库。结束时仅清理本次测试的键，不执行 `FLUSHDB`。

浏览器验证可使用独立命名空间与端口，不影响原有 8787 本地应用：

```sh
REDIS_NAMESPACE=inou-browser-test PORT=8788 npm run start:cloud
```

2026-11-07 已通过：6 项 SQLite 服务测试、真实 Upstash 上的双实例集成测试、Redis 后端上的 15 项浏览器回归检查、前端构建和依赖审计。浏览器检查使用桌面 Chromium，不能替代 iPhone 真机验收。Vercel 构建成功也不等于公网双设备通信已经验收。

## 仍需完成

1. 配置自有 STUN/TURN；未配置时无法保证不同 NAT 或蜂窝网络之间连接。
2. 两台 iPhone 在最终 HTTPS 域名下验证安装、后台/锁屏、切网、离线恢复、图片和备份。
3. 独立密码与安全评审；当前仍是 WebRTC DTLS + 身份签名信令，未实现应用层 Double Ratchet。
4. 大量历史与图片的性能测试、流量和 Redis/Vercel 用量监控；免费额度不代表无限用量。

参考：[Vercel WebSockets](https://vercel.com/docs/functions/websockets)、[Vercel SQLite 限制](https://vercel.com/kb/guide/is-sqlite-supported-in-vercel)、[Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)。
