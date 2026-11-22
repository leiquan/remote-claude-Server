# Ubuntu 上试运行 Claude Code 网页网关

浏览器通过同源 HTTPS 访问网页和网关。网关在 Ubuntu 上调用本机 Claude Code CLI，使用 SSE 返回回复。Claude 账号在 Ubuntu 上登录，网页只接收网关访问令牌。

## 隔离验证

在独立目录检出评审分支。用专用的非 root 用户安装 Node.js 22+ 和 [Claude Code CLI](https://code.claude.com/docs/en/setup)，运行 `claude auth login` 和 `claude auth status`。该用户应拥有独立的 HOME 和空工作目录。验证该账号和模型可用后，再启动网关。

在项目目录运行 `npm ci`、`npm test` 和 `npm run typecheck`。用仅该用户可读的环境文件设置以下值。另行用 `openssl rand -hex 32` 生成 `GATEWAY_ACCESS_TOKEN` 并写入同一文件。环境文件设为 0600，放在 Git 仓库之外。

```dotenv
GATEWAY_BIND_HOST=127.0.0.1
GATEWAY_PORT=43124
REMOTE_CLAUDE_ADAPTER=cli
BROWSER_HOST=disabled
CLAUDE_CLI_CWD=/var/lib/remote-claude-staging/workspace
CLAUDE_CLI_MODELS=sonnet,opus,haiku
# CLAUDE_CLI_EXECUTABLE=/absolute/path/to/claude
```

把工作目录和端口调整为测试实例实际使用的值。Node 22+ 可通过 `node --env-file=/path/to/staging.env --import tsx server/src/main.ts` 启动。先通过 SSH 隧道访问测试端口。

```sh
ssh -N -L 43124:127.0.0.1:43124 USER@UBUNTU_HOST
```

打开 `http://127.0.0.1:43124/web`，输入测试令牌。逐项验证首次回复、切换模型后继续追问、新建与切换会话、取消流式回复，以及刷新网页后恢复最近的成功消息。用错误令牌确认会话列表不可读。浏览器经实际 HTTPS 域名访问后，再验证 SSE 的首段文字在生成结束前到达。Nginx 反向代理可设置 `proxy_buffering off`，并将网页与 API 转发给同一个网关实例。

## 运行行为

- 模型菜单来自 `CLAUDE_CLI_MODELS`。使用当前账号有权调用的模型别名或完整模型 ID。网关不会自动探测账号模型权限。
- 网关保留会话和最近 20 个成功轮次，进程重启后清空。删除操作移除网关会话。Claude Code 自身的本机记录受其保留设置管理。
- CLI 延续上下文时从上次成功的会话派生，取消或失败的轮次不会替换这个续接点。同一网关会话只运行一个生成请求。
- CLI 禁用内置工具，使用安全模式。网关仅转发主会话回复文本，取消会终止本机 CLI 进程。上游停止状态未知。
- `/health` 是本机协议检查。一个会话的 `claudeUsable` 在首个成功轮次后变为 true。
