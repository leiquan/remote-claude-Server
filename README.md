# Remote Claude

独立的个人网关骨架，不是 Anthropic 官方产品，也不连接 Claude 网站。

iOS 将来只访问用户自己填写的一个 HTTPS 网关基址。Claude 网站登录如果以后实现，也必须发生在用户自己的 Ubuntu 浏览器主机上。本里程碑没有实现该登录适配器，也没有 Anthropic API key 转发。

## 这个里程碑做了什么

- `GET /health` 做网关本地的协议识别。`claudeUsable` 恒为 `false`。
- 网关访问令牌保护全部控制操作。令牌和 Claude 登录无关。
- 会话、登录状态机、模型、消息、取消和 SSE 的 v0 契约。
- 默认适配器 `unconfigured`：实时登录和实时模型明确返回 `not_configured`，不会假登录，也不会给出假的 Claude 模型列表。
- 适配器 `browser`：网关认证通过后，可以为该会话打开隔离的本机浏览器上下文，并用 `browser_navigate`、`browser_read`、`browser_click`、`browser_screenshot` 操作允许列表里的页面。页面加载不是 Claude 登录。模型列表和发送仍是 `not_configured`。Claude 没有专用密码。普通请求登录页被 Cloudflare challenge 拦截，所以自动浏览器登录停止。
- 适配器 `mock`：只在测试里模拟状态和回声，响应用 `simulated: true` 标出。

## 明确没做

- 不调用 Claude 网站或未公开接口。
- 不提取 cookie 或令牌，不绕过机器人检查，不承诺不可检测。
- 不部署，不申请证书，仓库里没有可用凭据。
- 本仓库不包含 iOS 客户端。客户端源码扫描 **NOT EXECUTED**。七项隔离计划仍是 **NOT EXECUTED ON IOS**。网关测试不能证明 iOS 隔离。

## 目录

- `server/`：Node.js 22 网关，目标运行环境是 Ubuntu。
- `contracts/`：OpenAPI、语义决定、仍标记为未执行的 iOS 隔离测试计划。
- `tests/`：只验证本机网关契约。依赖 `ios/` 的源码扫描被跳过，没有执行。
- `deploy/UBUNTU.md`：占位部署说明，不要按它实际上线。
- `PROVENANCE.md`：这次服务器导入的来源提交。

## 本地运行

```bash
npm install
npm test
npm run typecheck
GATEWAY_ACCESS_TOKEN=REPLACE_WITH_GATEWAY_ACCESS_TOKEN npm start
```

样例口令会被进程拒绝。不设置令牌时，健康检查可用，控制路由返回 `auth_not_configured`。令牌只放在进程环境里，不要写进仓库。

默认监听 `127.0.0.1:43123`。这是本机 HTTP，不是手机应使用的 HTTPS 基址。手机面前必须有操作者自己的 TLS，本仓库不提供证书。

```bash
curl -sS http://127.0.0.1:43123/health
```

契约细节在 `contracts/decisions.md`。
