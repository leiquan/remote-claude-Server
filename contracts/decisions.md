# v0 契约决定

本文件固定第一里程碑的语义。实现以这里和 `openapi.yaml` 为准。只有一套路由，没有并行的 `/v0` 与 `/v1`。

## 路由

路径相对于客户端配置的 base。服务进程自己提供：

| 方法 | 路径 | 认证 |
| --- | --- | --- |
| GET | `/health` | 不需要 |
| POST | `/sessions` | Bearer 网关令牌 |
| GET | `/sessions/{sessionId}` | Bearer 网关令牌 |
| DELETE | `/sessions/{sessionId}` | Bearer 网关令牌 |
| POST | `/sessions/{sessionId}/actions` | Bearer 网关令牌 |
| GET | `/sessions/{sessionId}/events` | Bearer 网关令牌 |

`protocolVersion` 是字段 `"0"`，不是路径前缀。`GET /v0/health` 不存在。

健康检查是协议识别，不是控制操作，也不证明 Claude 可用。响应里的 `claudeUsable` 在本里程碑恒为 `false`。`authentication.thisResponseAuthorizesControl` 恒为 `false`。

## 网关认证和会话所有权

网关令牌与 Claude 网站登录无关。控制操作都要 `Authorization: Bearer <token>`。

- 未配置令牌：`503 auth_not_configured`。进程仍提供健康检查。
- 缺少令牌：`401 auth_required`。
- 令牌错误：`401 auth_invalid`。
- 比较使用 SHA-256 后的定时比较。日志、错误和健康检查都不回显令牌。
- 占位符 `REPLACE_WITH_GATEWAY_ACCESS_TOKEN` 会被拒绝，不能当成可用口令。短于 16 字符的配置直接拒绝启动。

未认证请求在查会话之前失败。已存在和从不存在的会话返回同一份 401 正文，事件接口也不会先变成 `text/event-stream`。认证通过后，未知会话是 `404 session_not_found`，正文不回显原始 id。

v0 是单操作者模型，不是多用户隔离。一个进程只配置一个 `GATEWAY_ACCESS_TOKEN`，也只有一个网关身份。会话保存该令牌的指纹；指纹不符时按不存在处理。错误令牌会先被认证层拒绝，所以第二个身份无法表示，也不能访问已有会话。持有这个唯一令牌的一方可以看到本进程里的全部会话。

## Claude Code CLI 和网页

`GET /web` 提供同源网页。认证后的 `GET /sessions` 返回当前操作者的会话摘要。`cli` 由操作者在服务器上配置，登录 Claude 的步骤在本机 CLI 完成。模型来自服务器配置。它使用现有的选模型、发送、取消和 SSE 接口。获得成功回复后，单个会话的 `claudeUsable` 为 true。已完成的最近 20 轮可通过单个会话的 GET 接口读取，重启网关清空会话。

CLI 同一会话只允许一个进行中的生成，发送前需要连接事件流。最后一个订阅者断开时，网关取消本地 CLI 任务，`stop.upstream` 为 `unknown`。连接恢复后可以重放保留的 SSE 事件。CLI 失败通过 SSE `error` 报告，错误码为 `cli_failed`。

## 适配器

`REMOTE_CLAUDE_ADAPTER` 接受 `unconfigured`（默认）、`mock` 和 `browser`。`browser` 不表示已经登录。

- `unconfigured`：浏览器登录适配器未实现。不连接 Claude，不返回假模型，不进入 `authenticated`。
- `mock`：只给契约测试用的模拟回声。`simulated: true`。`claudeUsable` 仍是 `false`。模型 id 固定为 `sim.echo`，显示名包含 “not Claude”。

`login_input` 不接收密码、cookie、令牌或会话密钥。出现这类字段时返回 `400 payload_rejected`，不记录字段值。`simulationResult` 只在 mock 的 `verification` 步骤生效；unconfigured 即使收到 `authenticated` 也不会改变状态。

## 登录状态

`unauthenticated`、`authenticating`、`verification_required`、`authenticated`、`expired`、`failed`。

一个会话只有一条登录记录，`loginId` 在创建时分配并保持不变。

mock 的合法迁移：

- `unauthenticated`、`failed`、`expired` + `step=start` → `authenticating`
- `authenticating` + `step=challenge` → `verification_required`
- `verification_required` + `step=verification` + `simulationResult` → `authenticated`、`failed` 或 `expired`

其它迁移是 `409 invalid_state`。unconfigured 上任何 `login_input` 都是 `501 not_configured`，状态保持 `unauthenticated`。

`allowedActions` 只列出当前真正可执行的动作。unconfigured 下为空。mock 在未模拟登录完成时只有 `login_input`；`authenticated` 后才有 `select_model` 和 `send_message`。存在进行中的请求时追加 `cancel`。

能力字段：

- 网关自身的检测、认证、会话、状态机、事件流和取消是 `supported` 或在未配置令牌时把 `gatewayAuth` 标成 `not_configured`。
- Claude 网站登录、实时模型目录、实时对话只会出现 `not_configured` 或 `simulated`，不会出现 `supported`。

因此客户端不能把健康检查成功理解成 Claude 可用。能力是 `not_configured` 时，动作直接返回 `not_configured`，而不是暗示“先登录就能用”。

## 动作

动作按 `type` 区分：`login_input`、`select_model`、`send_message`、`cancel`。

- `actionId` 是客户端生成的幂等键，同一会话内一次有效。
- 相同 `actionId` 和相同规范化正文：返回 `status: duplicate`，`originalStatus` 是第一次的结果，不产生第二次生成。
- 相同 `actionId` 和不同正文：`409 action_id_conflict`，不覆盖第一次。
- `send_message` 另外用 `clientRequestId` 表示同一次用户提交，用 `requestId` 关联事件流。
- 相同 `clientRequestId` 且模型与文本相同：复用原来的 `requestId`，即使 `actionId` 不同。
- 相同 `clientRequestId` 但内容不同：`409 client_request_conflict`。
- 相同 `requestId` 被另一条消息复用：`409 request_id_conflict`。这是对提议字段的补充，用来避免两条生成共用一个事件关联键。

`send_message` 被接受时 HTTP 202。202 只表示网关收下了动作，不表示有 Claude 回复。完成、失败和取消都走事件流。

mock 的对话字段 `text` 是最近一次被接受的用户文本，不是模型回复。回复只出现在模拟的 `delta` 里，而且是把用户文本回声拆成两段。

## 事件

`GET .../events` 是 SSE。事件类型：

- `delta`、`completed`、`error`、`auth_required`：提议里的四类。`auth_required` 只表示模拟会话还没登录，不是网关 401。网关认证失败不会进入事件流。
- `cancelled`：取消或删除会话时的终止事件。`actionId` 是取消动作；删除会话时为 `null`。`sourceActionId` 指向原来的 `send_message`。`cause` 是 `client_cancel` 或 `session_deleted`。
- `login_state`：登录状态变化。没有它，事件流就无法表达 `verification_required`。

`Last-Event-ID` 命中已保留事件时，从下一条重放。未知或过期游标是 `409 event_cursor_invalid`。响应写明必须重新同步，网关不会据此恢复一次发送。重连只重放，不会把未完成的生成接着跑。每个会话最多保留 500 条，更早的会被丢掉。

事件流连接以底层 socket 关闭为准。读完某个 POST 的请求体不会取消生成。同一会话可以有多个订阅者；只在最后一个订阅者的 socket 关闭时，取消该会话里仍在本地转发的 mock 生成，清除定时器，并写入 `cancelled`，`cause` 为 `subscriber_disconnect`。这条事件的 `stop` 把本地转发标成 `stopped`，页面停止标成 `not_attempted`，上游标成 `not_applicable`。它只说明本地回声定时器停了。关闭 SSE 不会关闭浏览器页面，也不能证明 Claude 的计算已经停止。重复关闭是幂等的，不会再写 `completed`。取消或失败之后也不会补一条 `completed`。

重连不会恢复被取消的生成。`Last-Event-ID` 仍然只重放已保留的事件，其中包括这条取消。要继续对话，客户端必须用新的 `actionId`、`requestId` 和 `clientRequestId` 再提交一条消息，并且当时至少有一个事件订阅者。明确的 `cancel` 使用 `cause` `client_cancel`。`DELETE` 使用 `session_deleted`，然后关闭流。重复删除一个本进程删过的会话返回 204；从未存在的 id 返回 404。会话只在进程内存里，重启后全部失效。

所有已定义错误的 `retryable` 都是 `false`。客户端可以用同一个 `actionId` 安全重放，那是幂等，不是自动换主机重试。

## 错误

错误只有 `code`、`message`、`retryable`。动作结果外面还有 `actionId`、`requestId`、`status`、`originalStatus`、`originalActionId` 和当前会话快照。

正文不得包含令牌、cookie、上游 URL 或用户提交的密钥。路径穿越和百分号编码返回 `400 invalid_path`，不回显原始路径。

## 浏览器登录

2026-11-17 查阅 Claude Help Center 的公开文章 “Log in to your Claude account”。文章写明目前不能为 Claude 账户创建专用密码。公开登录方式是 Continue with Google，以及 Continue with email 的一次性链接。在另一台设备打开邮件时，原设备要输入验证码。

同一天用普通 HTTP 客户端请求公开登录页，得到 HTTP 403，响应头 `cf-mitigated: challenge`，页面标题是 “Just a moment...”。这是站点侧的自动化访问拦截。本仓库不绕过该拦截，也不提取 cookie。

浏览器宿主是单独的本机 Chrome 进程，经 stdio 管道控制，没有 TCP 调试端口，默认不启动。网关认证通过之后才会为该会话创建独立浏览器上下文；未认证请求不会分配浏览器资源。`DELETE` 只关闭该会话自己的上下文，并丢掉迟到结果。`browserHost.claudeNavigation` 固定为 `disabled`，`liveLoginVerified` 固定为 `false`。页面加载或标题不是 Claude 登录证明。宿主只接受操作者写入 `BROWSER_ALLOWLIST` 的源站，匹配的是 scheme、主机和有效端口。导航离开允许列表，或标题像 challenge、forbidden、expired、unrecognized 时，停止继续自动操作，不回退到 mock。`browser_navigate`、`browser_read`、`browser_click`、`browser_screenshot` 的 `localAck` 只表示本机命令被执行；`siteAck` 固定为 `false`。没有真实页面证据时，模型列表保持为空，`select_model` 和 `send_message` 保持未配置。不确定是否发出的消息不会自动重试。程序不会把 Claude 放进允许列表，也不发明站点选择器。关闭页面时 `stop.page` 为 `attempted`，`stop.upstream` 为 `unknown`，不是 `confirmed_stopped`。

因此 `REMOTE_CLAUDE_ADAPTER=browser` 不表示已经登录。浏览器适配器上的删除若关闭了页面，只记录页面停止已尝试、上游状态未知。`browserLogin.passwordLogin` 固定为 `unsupported`，`verified` 固定为 `false`。`automatedAccess` 为 `blocked`，`blocker` 为 `cloudflare_challenge`。`login_input` 返回 `501 login_method_unavailable`，登录状态保持 `unauthenticated`。没有操作者在主机上完成 Google 登录或邮件验证之前，实时模型与对话仍是 `not_configured`。

## 明确不做

不调用 Claude 网站或未公开接口，不读取浏览器 cookie，不绕过机器人检查，也不承诺不可检测。实时浏览器登录适配器保持未实现。
