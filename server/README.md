# 网关进程

Ubuntu 22.04 或 24.04 上使用 Node.js 22。没有原生扩展，也不需要安装浏览器。浏览器登录适配器未实现。

```bash
npm install
npm test
GATEWAY_BIND_HOST=127.0.0.1 GATEWAY_PORT=43123 npm start
```

环境变量见 `config.sample.env`。进程不会自动读取 `.env`，避免把样例占位符加载成口令。

`REMOTE_CLAUDE_ADAPTER=mock` 只用于本地契约试验。它仍然不是 Claude。`browser` 在 `BROWSER_HOST=enabled` 时启动本机 Chrome，经管道控制，没有 TCP 调试端口。认证通过后每个会话有自己的浏览器上下文。浏览器动作的 `localAck` 不是站点确认，`claudeLoginVerified` 固定为 `false`。程序不会导航到 Claude。面向手机的进程保持 `unconfigured` 和 `BROWSER_HOST=disabled`。
