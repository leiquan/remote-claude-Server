# 来源

这个 GitHub 仓库是 Remote Claude 的服务器目的地。Origin 上的单仓库保留为来源，不在这里改写它的历史。

- 导入时的来源提交：`682dcfa33006c8683cb045ffe925ae80392d53ef`
- 来源提交是一次已完成的服务器实现，包含认证后的本机会话浏览器、夹具测试和部署模板。
- 本次导入没有从更早的 `55ac3ee` 工件覆盖这棵树。
- 目标仓库在导入前没有提交。这是它的第一次普通推送，不是强推，也没有改写已有历史。
- 未复制：`ios/`、客户端源码扫描所依赖的 iOS 树、`node_modules`、构建产物、运行状态、cookie、令牌和本机产物压缩包。
- `tests/ios-boundaries.test.ts` 在来源里读取 `ios/Sources`。这里改成显式跳过，**没有执行**。跳过不是通过。
- `contracts/client-isolation-test-plan.md` 仍在，七项都标记为 **NOT EXECUTED ON IOS**。网关测试只检查这份标记，不能证明 iOS 隔离。
- 导入过程没有请求 Claude 网站，也没有打开真实登录页。
- 导入核实之后，服务器改动以这个 GitHub 仓库为准。不要让 Origin 和这里各长出一套服务器实现。iOS 由客户端工程师单独迁移，本导入不接触那个仓库。
