# 本机协作运行台

亮色、只读的Worker监视页面。Hub控制台展示远端调度，本页补充本机PID、CLI子进程、公开会话和stdout/stderr，区分“在线”和“任务确实在执行”。

## 启动

要求Node.js 20+；完整Hub/进程采集要求Windows PowerShell 5.1。无需额外npm依赖。

```powershell
# 自动选择LOCALAPPDATA/AI-Collab下唯一包含worker-config.json的目录
./scripts/start_worker_monitor.ps1
# 多账号或自定义目录
./scripts/start_worker_monitor.ps1 -ProfileDir 'D:/Collab/profiles/alice' -Port 8787
# 不打开浏览器
./scripts/start_worker_monitor.ps1 -ProfileDir 'D:/Collab/profiles/alice' -NoOpen
```

也可前台运行，Ctrl+C停止：

```powershell
$env:AI_COLLAB_PROFILE = 'D:/Collab/profiles/alice'
pnpm collab:monitor
# 或 node scripts/worker-monitor/server.mjs --profile 'D:/Collab/profiles/alice' --port 8787
```

默认地址：http://127.0.0.1:8787/ 。启动器复用同目录/端口的已有服务，后台URL/PID保存在配置目录的monitor-process.json。关闭页面不会停止服务，本页也不启动/停止业务Worker。

## 配置目录

Worker CLI本身不自动创建这些监视文件，需要由本机启动配置生成或手工准备。监视页不改写业务配置。最小worker-config.json：

```json
{
  "username": "alice",
  "agentType": "codex",
  "workerId": "worker_codex_example",
  "projectId": "project_example",
  "projectName": "Example Project",
  "hubUrl": "https://hub.example.com",
  "workspaceDir": "D:/Unity/Example",
  "taskWorkspaceRoot": "D:/Collab/tasks"
}
```

agentType支持codex/grok（默认codex）。projectName、sourceCommit、messageModel为可选展示字段。Hub允许HTTPS或回环HTTP，拒绝URL内嵌凭据，不携带认证头跟随重定向。

凭据优先读取启动环境HUB_TOKEN，否则读取配置目录的hub-token.dpapi。这里必须使用**个人令牌**（控制台 → 令牌，创建时不要绑定 Agent）：监视台要读取 Worker 列表、项目任务与消息，这些属于用户级读接口；Agent 令牌只能读事件流，会得到 403。DPAPI文件由同一Windows用户生成：

```powershell
$secureToken = Read-Host 'Hub token' -AsSecureString
$secureToken | ConvertFrom-SecureString | Set-Content -Encoding UTF8 'D:/Collab/profiles/alice/hub-token.dpapi'
```

可选worker-process.json：

```json
{
  "launcherPid": 1234,
  "nodePid": 5678,
  "stdout": "D:/Collab/profiles/alice/worker-example.stdout.log",
  "stderr": "D:/Collab/profiles/alice/worker-example.stderr.log"
}
```

PID需是真实当前值：launcherPid为Node父进程、nodePid为Worker进程，可只提供其一。候选进程还须匹配标准Worker CLI或ai_collab_worker.mjs入口，防止旧PID复用指向其他程序。无有效PID时尝试匹配CLI的--worker-id/workspace参数；无法匹配不等于进程一定不存在。

日志路径须位于配置目录内。启动记录缺失时回退目录内最新worker-*.stdout.log及对应stderr；没有日志/Hub时页面仍可打开并显示原因。

## 展示与限制

- Worker进程、Hub在线状态分别显示；心跳使用北京时间。
- CLI子进程区分收件、任务、UVCS、Unity；无模型子进程显示空闲，不代表离线。
- 项目最近100条消息，按收到/发出筛选；旧Hub无项目消息接口时回退最近12任务消息。
- 任务状态、角色、领取次数；多次领取提示检查错误。
- inbox/*.json中的持久游标、待发送回复；日志存在不等于网络一直畅通。
- CLI对话仅支持Codex：最近两天，匹配本配置message-session/taskWorkspaceRoot的最新各一个会话，最后6条公开消息，不展示内部推理。Grok可查看进程/消息/日志，不读取其专有会话格式。
- Worker最后240行、stderr最后100行；筛选、暂停/恢复、跟随末尾、复制。
- Hub事件为服务本次启动后采集的最近120条，不是无限历史浏览。

页面2秒刷新，进程/Hub每5秒采集；20秒以上快照提示陈旧。限量尾读不代替完整存档。

## 访问边界

仅绑定127.0.0.1，只提供GET，不发送消息/修改任务/控制Worker。拒绝异常Host、跨站Origin和跨站Fetch；页面使用CSP，内容按纯文本渲染。服务端对常见凭据字段、Bearer/JWT/API key等尽力脱敏；不向浏览器返回原始配置/解密令牌。消息和日志仍可能含业务信息，不应端口转发或公开服务，自动脱敏不覆盖所有自由文本。

## 验证

```powershell
pnpm test:monitor
```

核心测试覆盖配置发现、日志回退、路径限制、尾读/脱敏、长元信息的专属会话与内部推理排除、Host/Origin。HTTP测试覆盖配置缺失/只读/亮色页面；Windows上另启mock Hub验证真实PowerShell只发送GET且不回传令牌。测试不访问生产Hub。
