# 可选的执行端协作扩展

这是从本机适配层整理的可复用模块，默认 Worker 入口保持不变。扩展提供节点汇报、同一执行上下文的提问/回复、持久发件箱，以及基于接管通知的协作目标更新。目前附带的启动器支持 Codex，Grok 仍使用标准入口；一个进程只启动一个 Worker。

## 启动

先执行 `pnpm install --frozen-lockfile` 和 `pnpm build`。在仓库外的私有目录保存 `worker-config.json`，例如：

```json
{
  "hubUrl": "https://hub.example.org",
  "projectId": "example-project",
  "agentId": "codex-a",
  "adapter": "codex",
  "workspaceDir": "/work/project-baseline",
  "taskWorkspaceRoot": "/work/task-attempts",
  "cmBinary": "/usr/local/bin/cm",
  "unityEditor": "/opt/unity/Editor/Unity",
  "progressReportingEnabled": true,
  "progressPeerAgent": "codex-b",
  "automaticPeerRoutingEnabled": true,
  "deliveryEvidenceEnabled": true,
  "newFileStagingEnabled": true,
  "messageWorkspaceDir": "/work/dedicated-message-session",
  "messageEditingEnabled": false
}
```

所有路径必须换成本机真实路径。基准工作区只用于读取基线，执行尝试在独立目录创建。`messageWorkspaceDir` 用于独立消息会话；若显式开启 `messageEditingEnabled`，它必须是已准备好的 Unity 工程、位于配置的 `messageBranch`（`/main/ai/...`），且会启用消息CLI的本机完整执行能力。默认示例只读；这不是操作系统强制的项目目录沙箱。

通过已有的安全凭据机制将绑定本 Agent 的令牌放入父进程 `HUB_TOKEN`；自动路由还需要具有只读Worker列表访问能力的用户身份 `HUB_CONTROL_TOKEN`。不要把令牌写入配置、脚本、命令行参数或提交到仓库。启动器构造客户端后立即移除这两个环境变量，模型子进程不会继承它们；不会自动授予管理员权限，也不修改任务CLI现有的本机授权策略。

```bash
pnpm collab:runtime --profile /private/worker-profile
```

自动路由依赖本版Hub对 `progress:` 线程的状态保留规则。原始Worker消息的等待/恢复语义不变；不要仅复制扩展后连接未包含该修正的旧Hub。

## 节点、提问与路由

父Worker在开始执行、工作区就绪、补丁应用、Unity批处理启动、CLI返回、签入、Hub提交及失败节点报告实际进度。任务CLI收到本机helper路径，可通过 `report --mailbox ... --stage ... --text ...` 报告细粒度完成节点，或 `ask ... --wait-seconds 90` 提问；`replies --mailbox ...` 读取迟到答复。等待超时不表示同意，模型不应伪造答复或跳过验证。

父进程保管认证并重试；邮箱与 `progress-outbox.json` 在私有profile目录，不纳入Unity资产。答复必须匹配项目、任务、线程、replyToId和协作者身份。历史消息不改写，已验证的接管者可回答原问题；进度答复不会启动第二个编辑器重做同一任务。

接管消息应明确写出唯一的 `toAgent=codex-b`。当前协作者可以通知切换；新Agent自报接管时，必须回复本机此前发给当前协作者的同任务同线程消息，并与新目标一致。来源校验、24小时时效、在线Worker核验均通过后才修改 `progressPeerAgent`；目标暂不在线则保留当前路由并每30秒重试。新路由不更改本机身份、权限或任务assignedAgent。

扩展也可通过 `installCollaborationRuntime` 嵌入自定义启动器；自动路由必须注入 `verifyPeer`，缺少核验器则拒绝启动。不可将“能收到消息”当成有权更换身份或管理员权限。

## 已知边界

- 开启newFileStagingEnabled后，父Worker仅纳管独立任务工作区Assets/ProjectDocs下允许类型的新文件，排除日志、越界路径与符号链接；已有文件修改通过applychanged纳入签入。模型仍需保持交付范围准确，不会递归添加整个工程的私有文件。
- 消息编辑与远程问答并不替代正式任务的租约、锁、编译或提交门禁；Hub确认提交前不会报告交付成功。
- 自动路由确认不等于审阅通过；本地幂等测试不等于真实跨主机业务验收。

运行测试：`pnpm test:collaboration`。样例和测试只含通用标识，不包含部署账号、主机或工程路径。

## 云端交付读取与执行证据

deliveryEvidenceEnabled使父Worker向收件CLI提供本机正式Worker状态、真实Unity版本查询和基准selector；收件cwd不再被当作正式执行环境是否存在的证据。可在私有profile中保存 `delivery-registry.json`，登记允许查询的变更集和文件：

```json
[{"changeset":"cs:11","files":[{"path":"ProjectDocs/review.md"}]}]
```

可为每个文件添加 `sha256` 以核对已知交付摘要。消息提及该变更集时，父Worker通过本机已登录的cm只读getfile查询，将文件和manifest放入profile/delivery-cache，供CLI实际读取。读前读后验证selector不变，不切换日常工程或收件分支；失败记录真实命令错误，不伪装成已取得文件。缓存读取并不等于Unity执行或审阅通过。私有registry、下载缓存和运行证据不得提交到公开仓库。
