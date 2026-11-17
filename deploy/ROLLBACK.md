# 回滚

这次运行没有部署，也没有改系统服务。

第一次安装和版本回滚不是同一件事。`deploy/remove-first-install.sh` 只删除还没有 `previous` 的 `current` 链接，并留下 `releases/`。已经有上一版本时它拒绝执行。`deploy/rollback-release.sh` 把 `current` 换回 `previous`。`deploy/switch-release.sh` 在临时根目录里原子切换 `releases/<version>`。这三个脚本都拒绝 `/etc` 和其他系统路径，也不调用 systemctl。测试只在临时目录跑。

若操作者以后只安装了新单元 `remote-claude-gateway.service`：

```bash
sudo systemctl stop remote-claude-gateway.service
sudo systemctl disable remote-claude-gateway.service
```

不要停止或覆盖机器上其他服务。若还没有执行安装，就没有需要回滚的进程。

反向代理示例使用独立的 `server_name gateway.example.invalid`。不要把它写进已经在用的站点文件。删除的是操作者自己新增的站点文件，然后只重载自己确认过的代理配置。
