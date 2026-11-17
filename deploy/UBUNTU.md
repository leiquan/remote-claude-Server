# Ubuntu 部署说明（模板）

本里程碑不执行部署。下面只是操作者以后自己使用的占位文本。不要把真实主机、证书或令牌写进仓库。安装前先运行 `deploy/preflight.sh`。它不会改现有服务。回滚见 `deploy/ROLLBACK.md`。操作步骤见 `deploy/OPERATOR.md`。

## 进程

在操作者自己的 Ubuntu 上：

```bash
npm ci
npm test
```

权威单元模板是 `deploy/remote-claude-gateway.service.sample`。令牌只放在单元外面的 `EnvironmentFile`，不要把令牌值写进单元。模板里的 `BROWSER_HOST=disabled`。如果机器上已经有 `remote-claude-gateway.service`，不要覆盖。

## TLS

手机客户端只接受 HTTPS。由操作者在本机反向代理上终止 TLS。示例站名是无效的占位符：

```nginx
server {
    server_name gateway.example.invalid;
    location / {
        proxy_pass http://127.0.0.1:43123;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

不要把这个代理指到 `claude.ai` 或任何上游模型服务。不要把事件流缓冲打开。

## 不做的事

- 不在本任务中安装服务、申请证书或开放端口。
- 不配置浏览器配置文件，不导入 cookie。
- mock 适配器不能被描述成已经登录 Claude。
