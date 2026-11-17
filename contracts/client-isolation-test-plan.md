# iOS 客户端隔离测试计划

这些用例描述未来 iOS 客户端必须遵守的网络隔离。它们在本文件中全部标记为 **NOT EXECUTED ON IOS**。

网关测试不能证明 iOS 隔离。`tests/` 里的通过只说明本机网关契约，不能代替在 iOS 上执行本计划。

共同规则：

- 客户端只有一个用户输入的 HTTPS 基址。
- 每一跳都按解析后的 scheme、规范化主机、有效端口和路径段比较，禁止字符串前缀。
- 禁止 WebView、外部浏览器登录、远程图片、远程脚本、遥测。
- 禁止自动跟随重定向。任何 3xx 都是失败，并且不得发出下一次请求。
- 失败就停，没有备用主机、备用 scheme 或本地假登录。
- 网关访问令牌和 Claude 登录是两回事。令牌按入口保存。

## 1. invalid-unconfigured-unreachable

状态：**NOT EXECUTED ON IOS**

无效、未配置或不可达的 base 不得进入任何业务访问。

步骤：

1. 输入空字符串、`http://`、带 userinfo 的 URL、无法解析的主机，以及一个没有服务的 HTTPS 基址。
2. 观察是否出现会话、登录、模型或消息界面。

期望：入口检查失败，停在入口屏。不创建会话，不发送业务请求，不改走另一个地址。

## 2. flows-stay-on-base

状态：**NOT EXECUTED ON IOS**

全部业务流程只访问该 base。

步骤：

1. 配置一个通过检查的 HTTPS 基址。
2. 执行健康检查、创建会话、读取会话、提交动作、订阅事件、取消和删除。
3. 记录每一条实际请求的 URL。

期望：每条请求的 scheme、主机、有效端口和路径段都落在该 base 之内。没有第二条 origin。

## 3. redirects-blocked

状态：**NOT EXECUTED ON IOS**

跨源、端口、scheme、路径的重定向在发出下一次请求前被阻止。

步骤：

1. 让 `GET {base}/health` 返回 301/302/307/308，Location 分别指向另一个主机、另一个端口、`http://`、以及 base 路径之外的路径。
2. 统计客户端随后发出的请求。

期望：客户端不跟随重定向。重定向响应本身算失败。下一条请求数为 0。

## 4. no-remote-resources

状态：**NOT EXECUTED ON IOS**

不加载远程图片、脚本或其他资源，也不把它们交给外部浏览器。

步骤：

1. 检查二进制和源码中不存在 WebView、Safari 视图、外部认证会话。
2. 运行时不发起图片、字体、脚本或遥测请求。
3. 网关错误文本里即使出现 URL，也不去加载。

期望：除配置的网关 API 请求外，没有任何出站资源请求。

## 5. lookalike-and-traversal

状态：**NOT EXECUTED ON IOS**

相似主机、路径前缀碰撞、点段和编码穿越被拒绝。

基址 `https://gw.example/remote` 必须拒绝，且不得发出请求：

- `https://gw.example/remote-claude`
- `https://gw.example.evil/remote`
- `https://gw.example:8443/remote`
- `http://gw.example/remote`
- `https://user:pass@gw.example/remote`
- `https://gw.example/remote/../admin`
- `https://gw.example/remote/%2e%2e/admin`
- `https://gw.example/remote/%2f%2e%2e%2fadmin`

期望：比较的是规范化主机、有效端口（省略时为 443）和按段解码后的路径。`/remote` 不是 `/remote-claude` 的前缀匹配。含糊百分号编码、`%2e%2e`、`%2f` 和点段在出站前被拒绝，而不是先规范化再发送。

## 6. timeout-background-reconnect

状态：**NOT EXECUTED ON IOS**

超时、后台和重连没有备用通道或回退源。

步骤：

1. 让健康检查超时。
2. 将应用切到后台再回前台。
3. 断开事件流后只允许用户对同一 base 重连。

期望：超时停在错误态。后台不切换主机，不打开 WebView，不使用后台传输去别的 origin。重连仍是原来的 scheme、主机、端口和路径段。

## 7. base-change-generation

状态：**NOT EXECUTED ON IOS**

更换 base 会取消旧请求，配置代际丢弃过期响应，凭据不迁移。

步骤：

1. 对入口 A 保存网关令牌和会话 id，并发起一个未完成请求。
2. 在响应返回前把入口改成 B。
3. 观察内存中的令牌、会话 id 和迟到的 A 响应。
4. 再切回 A。

期望：

- A 的请求被取消。
- 代际号增加。A 的迟到响应不得写入 B 的界面。
- 内存中的令牌先被清掉。
- A 的令牌和会话不会复制到 B。
- 切回 A 时，只读取 A 自己保存过的令牌，这不是迁移。

网关测试不能证明 iOS 隔离。
