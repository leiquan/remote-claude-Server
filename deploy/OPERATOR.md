# 操作者在自己的 Ubuntu 上要做的最少步骤

本文件不索要口令，也不代替登录。当前构建不会打开 Claude 网站，也不会重试已经确认被 challenge 拦住的自动访问。

## 依赖

- Ubuntu 上的 Node.js 22。
- 发行版或 Google 官方包安装的 Chrome / Chromium。程序不下载浏览器，不改指纹，不配置代理。
- 操作者自己能看见的图形会话。无头模式只适合本仓库的本地夹具测试，不能当成已经登录。
- 一个由操作者自己生成的网关访问令牌，长度至少 16，且不能是仓库里的占位符。把它放在模式为 `0600` 的环境文件里，不要提交，也不要贴回聊天。

## 环境变量名

- `GATEWAY_ACCESS_TOKEN`
- `GATEWAY_BIND_HOST`
- `GATEWAY_PORT`
- `GATEWAY_BASE_PATH`
- `REMOTE_CLAUDE_ADAPTER`（保持 `unconfigured`，直到另有一次经过核实的登录）
- `BROWSER_HOST`（`disabled` 或缺省不会启动浏览器；`enabled` 只启动本机浏览器）
- `BROWSER_EXECUTABLE`
- `BROWSER_ALLOWLIST`（操作者自己写下的源站列表，程序不会预填第三方站点）
- `BROWSER_HEADLESS`（`1` 只用于无界面夹具；面向自己登录时应不设置）

## 现在仍然不能自动完成的事

真实的网站登录和对话是完成门槛，不是可选项。浏览器宿主只允许访问明确列入 `BROWSER_ALLOWLIST` 的源站。Claude 导航在健康检查里固定为 `disabled`，`liveLoginVerified` 固定为 `false`。被 challenge 拦住的页面保持拦住，等操作者自己决定下一步。本仓库没有 Claude 页面选择器，夹具测试不能当作真实站点已经适配。

操作者若要继续，需要在自己的主机上打开可见浏览器，用网站公开支持的交互自己完成登录，并单独确认会话可用。那一步不由这次自动运行执行。

## 部署预检和回滚

先读 `deploy/preflight.sh`。它检查 Node 22 和可选的 `BROWSER_EXECUTABLE`，把显示、沙箱、权限、端口、单元和 TLS 记成已知或 unknown，始终输出 `deploy_ready=false`，不打印令牌值，也不改系统。

示例单元名是 `remote-claude-gateway.service`。如果机器上已经有同名单元，不要覆盖。回滚只停止这个新单元，见 `deploy/ROLLBACK.md`。
